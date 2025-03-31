#!/bin/bash
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

# === Configuration Setup ===
CONFIG_FILE="/etc/alternat.conf"
echo route_table_ids_csv=${ROUTE_TABLES_IDS} >> "$CONFIG_FILE"

# === Install Dependencies ===
echo "Installing required packages..."
sudo apt-get update
sudo apt-get install -y iptables unzip wget gnupg ca-certificates lsb-release

# Install AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
unzip -qq ./awscliv2.zip
./aws/install

# Install OpenResty
wget -4 -O - https://openresty.org/package/pubkey.gpg | sudo gpg --dearmor -o /usr/share/keyrings/openresty.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/openresty.gpg] http://openresty.org/package/arm64/ubuntu $(lsb_release -sc) main" | sudo tee /etc/apt/sources.list.d/openresty.list > /dev/null
sudo apt-get update
sudo apt-get -y install openresty

# === NAT Configuration (from alternat.sh) ===
panic() {
  [ -n "$1" ] && echo "$1"
  echo "Setup failed"
  exit 1
}

load_config() {
   if [ -f "$CONFIG_FILE" ]; then
      . "$CONFIG_FILE"
   else
      panic "Config file $CONFIG_FILE not found"
   fi
   validate_var "route_table_ids_csv" "$route_table_ids_csv"
}

validate_var() {
   var_name="$1"
   var_val="$2"
   if [ ! "$2" ]; then
      echo "Config var \"$var_name\" is unset"
      exit 1
   fi
}

configure_nat() {
   echo "Beginning NAT configuration"

   echo "Determining the MAC address on ens5"
   local ens5_mac="$(cat /sys/class/net/ens5/address)" || panic "Unable to determine MAC address on ens5."
   echo "Found MAC $ens5_mac for ens5."

   local vpc_cidr_uri="http://169.254.169.254/latest/meta-data/network/interfaces/macs/$ens5_mac/vpc-ipv4-cidr-blocks"
   echo "Metadata location for vpc ipv4 ranges: $vpc_cidr_uri"

   local vpc_cidr_ranges=$(eval "$CURL_WITH_TOKEN \"$vpc_cidr_uri\"")
   if [ $? -ne 0 ]; then
      panic "Unable to obtain VPC CIDR range from metadata."
   else
      echo "Retrieved VPC CIDR range(s) $vpc_cidr_ranges from metadata."
   fi

   IFS=' ' read -r -a vpc_cidrs <<< $(echo "$vpc_cidr_ranges")

   echo "Enabling NAT..."
   sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.ens5.send_redirects=0 net.ipv4.ip_local_port_range="1024 65535" || panic

   for cidr in "${vpc_cidrs[@]}";
   do
      (iptables -t nat -C POSTROUTING -o ens5 -s "$cidr" -j MASQUERADE 2> /dev/null ||
      iptables -t nat -A POSTROUTING -o ens5 -s "$cidr" -j MASQUERADE) || panic
   done

   sysctl net.ipv4.ip_forward net.ipv4.conf.ens5.send_redirects net.ipv4.ip_local_port_range
   iptables -n -t nat -L POSTROUTING

   echo "NAT configuration complete"
}

disable_source_dest_check() {
   echo "Disabling source/destination check"
   aws ec2 modify-instance-attribute --instance-id $INSTANCE_ID --source-dest-check "{\"Value\": false}"
   if [ $? -ne 0 ]; then
      panic "Unable to disable source/dest check."
   fi
   echo "source/destination check disabled for $INSTANCE_ID"
}

configure_route_table() {
   echo "Configuring route tables"

   IFS=',' read -r -a route_table_ids <<< "${route_table_ids_csv}"

   for route_table_id in "${route_table_ids[@]}"
   do
      echo "Attempting to find route table $route_table_id"
      local rtb_id=$(aws ec2 describe-route-tables --filters Name=route-table-id,Values=${route_table_id} --query 'RouteTables[0].RouteTableId' | tr -d '"')
      if [ -z "$rtb_id" ]; then
         panic "Unable to find route table $rtb_id"
      fi

      echo "Found route table $rtb_id"
      echo "Replacing route to 0.0.0.0/0 for $rtb_id"
      aws ec2 replace-route --route-table-id "$rtb_id" --instance-id "$INSTANCE_ID" --destination-cidr-block 0.0.0.0/0
      if [ $? -eq 0 ]; then
         echo "Successfully replaced route to 0.0.0.0/0 via instance $INSTANCE_ID for route table $rtb_id"
         continue
      fi

      echo "Unable to replace route. Attempting to create route"
      aws ec2 create-route --route-table-id "$rtb_id" --instance-id "$INSTANCE_ID" --destination-cidr-block 0.0.0.0/0
      if [ $? -eq 0 ]; then
         echo "Successfully created route to 0.0.0.0/0 via instance $INSTANCE_ID for route table $rtb_id"
      else
         panic "Unable to replace or create the route!"
      fi
   done
}

# === OpenResty Configuration (from proxyScript.sh) ===
setup_openresty() {
   echo "Setting up OpenResty..."
   cp /etc/openresty/nginx.conf /etc/openresty/nginx-backup.conf
   aws s3 cp s3://ecs-clusters-space/OpenResty/nginx.conf /etc/openresty/nginx.conf
   sudo systemctl restart openresty
   echo "OpenResty setup complete"
}

# === Main Execution ===
echo "Starting setup..."

# Load config and fetch instance metadata
load_config

curl_cmd="curl --silent --fail"
echo "Requesting IMDSv2 token"
token=$($curl_cmd -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 900")
CURL_WITH_TOKEN="$curl_cmd -H \"X-aws-ec2-metadata-token: $token\""

export AWS_DEFAULT_OUTPUT="text"
export AWS_PAGER=""

II_URI="http://169.254.169.254/latest/dynamic/instance-identity/document"
INSTANCE_ID=$(eval "$CURL_WITH_TOKEN $II_URI" | grep instanceId | awk -F\" '{print $4}')
export AWS_DEFAULT_REGION=$(eval "$CURL_WITH_TOKEN $II_URI" | grep region | awk -F\" '{print $4}')

echo "############### SCRIPT VARIABLES ###############"
echo "TOKEN=$token"
echo "CURL_COMMAND=$CURL_WITH_TOKEN"
echo "INSTANCE_INFO=`$CURL_WITH_TOKEN $II_URI`"
echo "INSTANCE_ID=$INSTANCE_ID"
echo "AWS_REGION=$AWS_DEFAULT_REGION"
echo "################################################"

# Configure NAT and routing
configure_nat
# disable_source_dest_check
configure_route_table

# Configure OpenResty
setup_openresty

echo "Setup completed successfully!"