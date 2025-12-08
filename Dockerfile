# Build stage
FROM node:22.21 AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including devDependencies for building)
RUN npm install

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove devDependencies after build
RUN npm prune --production

# Production stage
FROM node:22.21.1-alpine

WORKDIR /app

# Install Python for any runtime needs (if required)
RUN apk add --no-cache python3 py3-pip

# Copy package files
COPY package*.json ./

# Copy production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy built application
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
