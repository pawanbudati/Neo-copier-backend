# Use a lightweight official Node.js image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application files
COPY . .

# Build the TypeScript project to JavaScript in dist/
RUN npm run build

# Expose port
EXPOSE 3000

# Set environment variable defaults
ENV PORT=3000
ENV NODE_ENV=production

# Start the server
CMD ["npm", "run", "start"]
