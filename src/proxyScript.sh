#!/bin/bash
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Hello World" > /hello-world.txt

sudo apt-get update
sudo apt-get install -y iptables unzip 
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
unzip  -qq ./awscliv2.zip
./aws/install

apt-get -y install --no-install-recommends wget gnupg ca-certificates lsb-release
wget -4 -O - https://openresty.org/package/pubkey.gpg | sudo gpg --dearmor -o /usr/share/keyrings/openresty.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/openresty.gpg] http://openresty.org/package/arm64/ubuntu $(lsb_release -sc) main" | sudo tee /etc/apt/sources.list.d/openresty.list > /dev/null
sudo apt-get update
sudo apt-get -y install openresty
sysctl -q -w net.ipv4.ip_forward=1 net.ipv4.conf.ens5.send_redirects=0 net.ipv4.ip_local_port_range="1024 65535" 

cp /etc/openresty/nginx.conf /etc/openresty/nginx-backup.conf
iptables -t nat -A POSTROUTING -o ens5 -j MASQUERADE

aws s3 cp s3://ecs-clusters-space/OpenResty/nginx.conf /etc/openresty/nginx.conf

sudo systemctl restart openresty
