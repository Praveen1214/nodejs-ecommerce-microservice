# Use Node.js 20 Alpine as base for a lightweight image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install dependencies for kubectl and the binary itself
RUN apk add --no-cache curl ca-certificates && \
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && \
    mv kubectl /usr/local/bin/

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Expose the application port
EXPOSE 6000

# Start the application
CMD ["npm", "start"]
