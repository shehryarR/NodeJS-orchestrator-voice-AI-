#!/bin/bash

# SSL Certificate Generator for Live Call Server
# This script generates self-signed SSL certificates for development/testing

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SSL_DIR="./ssl"
PRIVATE_KEY="$SSL_DIR/private-key.pem"
CERTIFICATE="$SSL_DIR/certificate.pem"
CSR_FILE="$SSL_DIR/certificate.csr"
CONFIG_FILE="$SSL_DIR/openssl.cnf"

# Certificate details
COUNTRY="US"
STATE="CA"
CITY="San Francisco"
ORGANIZATION="Live Call Server"
ORGANIZATIONAL_UNIT="IT Department"
COMMON_NAME="localhost"
EMAIL="admin@localhost"

# Certificate validity (in days)
VALIDITY_DAYS=365

echo -e "${BLUE}🔒 SSL Certificate Generator for Live Call Server${NC}"
echo "================================================="

# Check if OpenSSL is installed
if ! command -v openssl &> /dev/null; then
    echo -e "${RED}❌ Error: OpenSSL is not installed${NC}"
    echo "Please install OpenSSL first:"
    echo "  - Ubuntu/Debian: sudo apt-get install openssl"
    echo "  - CentOS/RHEL: sudo yum install openssl"
    echo "  - macOS: brew install openssl"
    echo "  - Windows: Download from https://slproweb.com/products/Win32OpenSSL.html"
    exit 1
fi

echo -e "${GREEN}✅ OpenSSL found: $(openssl version)${NC}"

# Create SSL directory if it doesn't exist
if [ ! -d "$SSL_DIR" ]; then
    echo -e "${YELLOW}📁 Creating SSL directory: $SSL_DIR${NC}"
    mkdir -p "$SSL_DIR"
else
    echo -e "${GREEN}✅ SSL directory already exists${NC}"
fi

# Check if certificates already exist
if [ -f "$PRIVATE_KEY" ] && [ -f "$CERTIFICATE" ]; then
    echo -e "${YELLOW}⚠️  SSL certificates already exist${NC}"
    echo "Private Key: $PRIVATE_KEY"
    echo "Certificate: $CERTIFICATE"
    echo ""
    read -p "Do you want to regenerate them? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}📋 Certificate Information:${NC}"
        openssl x509 -in "$CERTIFICATE" -text -noout | grep -E "(Subject:|Not Before|Not After|DNS:|IP Address:)"
        echo -e "${GREEN}✅ Using existing certificates${NC}"
        exit 0
    fi
    echo -e "${YELLOW}🔄 Regenerating certificates...${NC}"
fi

# Function to prompt for certificate details
prompt_cert_details() {
    echo -e "${BLUE}📝 Certificate Configuration${NC}"
    echo "Enter certificate details (press Enter for defaults):"
    echo ""
    
    read -p "Country Code (default: $COUNTRY): " input_country
    COUNTRY=${input_country:-$COUNTRY}
    
    read -p "State/Province (default: $STATE): " input_state
    STATE=${input_state:-$STATE}
    
    read -p "City (default: $CITY): " input_city
    CITY=${input_city:-$CITY}
    
    read -p "Organization (default: $ORGANIZATION): " input_org
    ORGANIZATION=${input_org:-$ORGANIZATION}
    
    read -p "Organizational Unit (default: $ORGANIZATIONAL_UNIT): " input_ou
    ORGANIZATIONAL_UNIT=${input_ou:-$ORGANIZATIONAL_UNIT}
    
    read -p "Common Name/Domain (default: $COMMON_NAME): " input_cn
    COMMON_NAME=${input_cn:-$COMMON_NAME}
    
    read -p "Email (default: $EMAIL): " input_email
    EMAIL=${input_email:-$EMAIL}
    
    read -p "Validity in days (default: $VALIDITY_DAYS): " input_days
    VALIDITY_DAYS=${input_days:-$VALIDITY_DAYS}
    
    echo ""
}

# Function to create OpenSSL configuration file
create_openssl_config() {
    echo -e "${YELLOW}📄 Creating OpenSSL configuration file...${NC}"
    
    cat > "$CONFIG_FILE" << EOF
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req

[dn]
C = $COUNTRY
ST = $STATE
L = $CITY
O = $ORGANIZATION
OU = $ORGANIZATIONAL_UNIT
CN = $COMMON_NAME
emailAddress = $EMAIL

[v3_req]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
DNS.2 = *.localhost
DNS.3 = $COMMON_NAME
IP.1 = 127.0.0.1
IP.2 = ::1
IP.3 = 192.168.1.100
IP.4 = 10.0.0.100
EOF

    echo -e "${GREEN}✅ OpenSSL configuration created${NC}"
}

# Function to generate private key
generate_private_key() {
    echo -e "${YELLOW}🔑 Generating private key...${NC}"
    
    openssl genrsa -out "$PRIVATE_KEY" 2048
    
    if [ $? -eq 0 ]; then
        chmod 600 "$PRIVATE_KEY"
        echo -e "${GREEN}✅ Private key generated successfully${NC}"
    else
        echo -e "${RED}❌ Failed to generate private key${NC}"
        exit 1
    fi
}

# Function to generate certificate signing request
generate_csr() {
    echo -e "${YELLOW}📝 Generating Certificate Signing Request...${NC}"
    
    openssl req -new -key "$PRIVATE_KEY" -out "$CSR_FILE" -config "$CONFIG_FILE"
    
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✅ CSR generated successfully${NC}"
    else
        echo -e "${RED}❌ Failed to generate CSR${NC}"
        exit 1
    fi
}

# Function to generate self-signed certificate
generate_certificate() {
    echo -e "${YELLOW}📜 Generating self-signed certificate...${NC}"
    
    openssl x509 -req -in "$CSR_FILE" -signkey "$PRIVATE_KEY" -out "$CERTIFICATE" \
        -days "$VALIDITY_DAYS" -extensions v3_req -extfile "$CONFIG_FILE"
    
    if [ $? -eq 0 ]; then
        chmod 644 "$CERTIFICATE"
        echo -e "${GREEN}✅ Certificate generated successfully${NC}"
    else
        echo -e "${RED}❌ Failed to generate certificate${NC}"
        exit 1
    fi
}

# Function to display certificate information
display_cert_info() {
    echo ""
    echo -e "${BLUE}📋 Certificate Information:${NC}"
    echo "================================="
    
    echo -e "${YELLOW}Subject:${NC}"
    openssl x509 -in "$CERTIFICATE" -subject -noout | sed 's/subject=//'
    
    echo -e "${YELLOW}Issuer:${NC}"
    openssl x509 -in "$CERTIFICATE" -issuer -noout | sed 's/issuer=//'
    
    echo -e "${YELLOW}Validity:${NC}"
    openssl x509 -in "$CERTIFICATE" -dates -noout
    
    echo -e "${YELLOW}Alternative Names:${NC}"
    openssl x509 -in "$CERTIFICATE" -text -noout | grep -A 10 "Subject Alternative Name" | grep -E "(DNS:|IP Address:)"
    
    echo -e "${YELLOW}Fingerprint (SHA256):${NC}"
    openssl x509 -in "$CERTIFICATE" -fingerprint -sha256 -noout
    
    echo ""
}

# Function to verify certificate
verify_certificate() {
    echo -e "${YELLOW}🔍 Verifying certificate...${NC}"
    
    if openssl x509 -in "$CERTIFICATE" -text -noout > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Certificate is valid${NC}"
    else
        echo -e "${RED}❌ Certificate verification failed${NC}"
        exit 1
    fi
    
    # Check if private key matches certificate
    cert_modulus=$(openssl x509 -in "$CERTIFICATE" -modulus -noout)
    key_modulus=$(openssl rsa -in "$PRIVATE_KEY" -modulus -noout 2>/dev/null)
    
    if [ "$cert_modulus" = "$key_modulus" ]; then
        echo -e "${GREEN}✅ Private key matches certificate${NC}"
    else
        echo -e "${RED}❌ Private key does not match certificate${NC}"
        exit 1
    fi
}

# Function to create .env file with HTTPS settings
create_env_settings() {
    echo -e "${YELLOW}⚙️  Creating HTTPS environment settings...${NC}"
    
    if [ -f ".env" ]; then
        # Update existing .env file
        if grep -q "USE_HTTPS" .env; then
            sed -i.bak 's/USE_HTTPS=.*/USE_HTTPS=true/' .env
        else
            echo "USE_HTTPS=true" >> .env
        fi
        
        if grep -q "HTTPS_PORT" .env; then
            sed -i.bak 's/HTTPS_PORT=.*/HTTPS_PORT=8443/' .env
        else
            echo "HTTPS_PORT=8443" >> .env
        fi
        
        if grep -q "SSL_KEY_PATH" .env; then
            sed -i.bak "s|SSL_KEY_PATH=.*|SSL_KEY_PATH=$PRIVATE_KEY|" .env
        else
            echo "SSL_KEY_PATH=$PRIVATE_KEY" >> .env
        fi
        
        if grep -q "SSL_CERT_PATH" .env; then
            sed -i.bak "s|SSL_CERT_PATH=.*|SSL_CERT_PATH=$CERTIFICATE|" .env
        else
            echo "SSL_CERT_PATH=$CERTIFICATE" >> .env
        fi
        
        echo -e "${GREEN}✅ Updated existing .env file with HTTPS settings${NC}"
    else
        echo -e "${YELLOW}⚠️  No .env file found. You may need to add these settings manually:${NC}"
        echo "USE_HTTPS=true"
        echo "HTTPS_PORT=8443"
        echo "SSL_KEY_PATH=$PRIVATE_KEY"
        echo "SSL_CERT_PATH=$CERTIFICATE"
    fi
}

# Function to provide usage instructions
show_usage_instructions() {
    echo ""
    echo -e "${BLUE}🚀 Usage Instructions:${NC}"
    echo "======================"
    echo ""
    echo "1. Start your server with:"
    echo -e "   ${GREEN}node server.js${NC}"
    echo ""
    echo "2. Access your application at:"
    echo -e "   ${GREEN}https://localhost:8443${NC}"
    echo ""
    echo "3. Browser Security Warning:"
    echo "   - Your browser will show a security warning for self-signed certificates"
    echo "   - Click 'Advanced' or 'Show Details'"
    echo "   - Click 'Proceed to localhost (unsafe)' or 'Accept Risk and Continue'"
    echo ""
    echo "4. For production use:"
    echo "   - Get a certificate from a trusted CA (Let's Encrypt, etc.)"
    echo "   - Replace the self-signed certificate with the CA-signed one"
    echo ""
    echo "5. Files created:"
    echo -e "   - Private Key: ${GREEN}$PRIVATE_KEY${NC}"
    echo -e "   - Certificate: ${GREEN}$CERTIFICATE${NC}"
    echo -e "   - CSR: ${GREEN}$CSR_FILE${NC}"
    echo -e "   - Config: ${GREEN}$CONFIG_FILE${NC}"
    echo ""
    echo -e "${YELLOW}⚠️  Important: Keep your private key secure and never share it!${NC}"
}

# Function to cleanup temporary files
cleanup_temp_files() {
    if [ -f "$CSR_FILE" ]; then
        rm "$CSR_FILE"
        echo -e "${GREEN}✅ Cleaned up temporary CSR file${NC}"
    fi
}

# Main execution
main() {
    echo ""
    
    # Check for custom certificate details
    if [ "$1" = "--interactive" ] || [ "$1" = "-i" ]; then
        prompt_cert_details
    else
        echo -e "${BLUE}ℹ️  Using default certificate details (use --interactive for custom)${NC}"
    fi
    
    echo ""
    echo -e "${YELLOW}🔧 Certificate Generation Process:${NC}"
    echo "1. Creating OpenSSL configuration"
    echo "2. Generating private key (2048-bit RSA)"
    echo "3. Creating certificate signing request"
    echo "4. Generating self-signed certificate"
    echo "5. Verifying certificate"
    echo ""
    
    # Execute generation steps
    create_openssl_config
    generate_private_key
    generate_csr
    generate_certificate
    verify_certificate
    display_cert_info
    create_env_settings
    cleanup_temp_files
    show_usage_instructions
    
    echo ""
    echo -e "${GREEN}🎉 SSL certificate generation completed successfully!${NC}"
    echo -e "${GREEN}🔒 Your Live Call Server is now ready for HTTPS${NC}"
}

# Help function
show_help() {
    echo "SSL Certificate Generator for Live Call Server"
    echo ""
    echo "Usage:"
    echo "  $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  -i, --interactive    Prompt for certificate details"
    echo "  -h, --help          Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                  Generate certificate with defaults"
    echo "  $0 --interactive    Generate certificate with custom details"
    echo ""
}

# Handle command line arguments
case "$1" in
    -h|--help)
        show_help
        exit 0
        ;;
    -i|--interactive)
        main --interactive
        ;;
    "")
        main
        ;;
    *)
        echo -e "${RED}❌ Unknown option: $1${NC}"
        echo "Use --help for usage information"
        exit 1
        ;;
esac