# TQSFT NAT Instance Project

A CDK-based project for deploying NAT instances with custom cloud-init configurations and proxy setup.

## Project Structure

. 
├── .npmignore - NPM ignore rules (excludes TypeScript files but keeps declarations) 
├── tsconfig.json - TypeScript configuration 
├── lib/ 
│ └── tqsft-nat-instance-stack.ts - Main CDK stack for NAT instance 
├── src/ 
│ ├── custom-cloud-init.txt - Cloud-init configuration for NAT instance 
│ ├── proxy-nat-script.sh - Proxy setup script for NAT instance 
├── test/ 
│ └── tqsft-nat-instance.test.ts - CDK stack tests 
└── package.json - Project dependencies and scripts

## Key Components

### 1. NAT Instance Stack (`lib/tqsft-nat-instance-stack.ts`)
- CDK stack that provisions NAT instances
- Uses AWS CDK v2.139.0

### 2. Cloud-Init Configuration (`src/custom-cloud-init.txt`)
- Multi-part MIME configuration for EC2 instance initialization
- Includes:
  - Cloud-config directives
  - User data scripts for route table configuration
  - Software installation (iptables, unzip)

### 3. Proxy Script (`src/proxy-nat-script.sh`)
- Sets up OpenResty (NGINX-based) proxy
- Configures:
  - AWS CLI installation
  - IP forwarding
  - NAT rules
  - OpenResty installation and configuration

## Development

### Prerequisites
- Node.js
- AWS CDK v2
- TypeScript 5.4.x

### Commands
```bash
npm install       # Install dependencies
npm run build     # Compile TypeScript
npm run watch     # Watch for changes and recompile
npm run test      # Run tests
cdk deploy        # Deploy stack
```

## Testing

- CDK stack tests in test/tqsft-nat-instance.test.ts

## Deployment

The project uses AWS CDK for infrastructure deployment. Configure your AWS credentials before deployment.

## Configuration
- Route tables are configured in `src/custom-cloud-init.txt`
- Proxy settings are in `src/proxyScript.sh`
