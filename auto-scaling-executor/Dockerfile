# Use lightweight Node image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install required tools
RUN apk add --no-cache \
    curl \
    bash \
    ca-certificates

# Install kubectl (official binary)
RUN curl -LO https://dl.k8s.io/release/v1.30.0/bin/linux/amd64/kubectl \
    && chmod +x kubectl \
    && mv kubectl /usr/local/bin/kubectl

# Verify kubectl installation
RUN kubectl version --client

# Copy package files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application source
COPY . .

# Application port
EXPOSE 6000

# Default kubeconfig path inside container
ENV KUBECONFIG=/root/.kube/config

# Start application
CMD ["npm", "start"]