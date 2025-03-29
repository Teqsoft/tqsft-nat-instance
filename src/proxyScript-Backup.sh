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

cat <<'EOF' > /etc/openresty/nginx.conf
#user  nobody;
worker_processes  1;

error_log  logs/error.log info;

#pid        logs/nginx.pid;


events {
    worker_connections  1024;
}

stream {
    log_format basic '$remote_addr [$time_local] '
                     '$protocol $status $bytes_sent $bytes_received '
                     '$session_time';

    access_log  logs/access-stream.log basic; 
    error_log  logs/error-stream.log;
    
    server {
        listen 0.0.0.0:10443 udp;

        # proxy_bind $remote_addr transparent;
        proxy_pass wg-admin.teqsoft.xyz.internal:10443;
    }
}

http {
    include       mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  logs/access.log main;

    sendfile        on;
    #tcp_nopush     on;

    #keepalive_timeout  0;
    keepalive_timeout  65;

    #gzip  on;

    server {
        listen       0.0.0.0:80;
        server_name  localhost;

        #charset koi8-r;

        location / {
            root   html;
            index  index.html index.htm;
        }

        #error_page  404              /404.html;

        # redirect server error pages to the static page /50x.html
        #
        error_page   500 502 503 504  /50x.html;
        location = /50x.html {
            root   html;
        }
    }
}
EOF

sudo systemctl restart openresty