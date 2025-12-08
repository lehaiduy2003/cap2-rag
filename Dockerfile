FROM node:18-alpine

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

# Create uploads directory
RUN mkdir -p uploads/documents

# Expose port
EXPOSE 3001

# Start the application
CMD ["npm", "start"]
