#!/bin/zsh
mkdir -p certs
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "")

cat > certs/openssl.cnf <<EOL
[req]
default_bits = 2048
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
CN = HAZORA-LOCAL

[v3_req]
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
EOL

if [ -n "$LAN_IP" ]; then
  echo "IP.2 = ${LAN_IP}" >> certs/openssl.cnf
fi

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -config certs/openssl.cnf 2>/dev/null

echo "✅ SSL Certs generated for localhost, 127.0.0.1${LAN_IP:+, and $LAN_IP}"
