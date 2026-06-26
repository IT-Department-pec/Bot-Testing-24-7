# Use a lightweight Node.js image
FROM node:20-alpine

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker layer caching
COPY package*.json ./

# Install ALL dependencies (do not omit devDependencies to avoid missing module errors)
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the port your app runs on
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]
