.PHONY: install server dev clean test

# Install dependencies
install:
	@echo "Installing dependencies..."
	npm install

# Start production server
server: install
	@echo "Starting WebSocket server..."
	node server.js

# Start development server with auto-reload
dev: install
	@echo "Starting development server..."
	npm run dev

# Clean node_modules and package-lock.json
clean:
	@echo "Cleaning project..."
	rm -rf node_modules
	rm -f package-lock.json

# Reinstall dependencies
reinstall: clean install

# Test the server
test:
	@echo "Running tests..."
	npm test

# Check if Node.js and npm are installed
check:
	@echo "Checking system requirements..."
	@node --version || (echo "Node.js is not installed. Please install Node.js 16 or higher." && exit 1)
	@npm --version || (echo "npm is not installed. Please install npm." && exit 1)
	@echo "System requirements met!"

# Setup project
setup: check install
	@echo "Creating public directory..."
	mkdir -p public
	@echo "Moving HTML, CSS, and JS files to public directory..."
	cp index.html public/ 2>/dev/null || true
	cp style.css public/ 2>/dev/null || true
	cp script.js public/ 2>/dev/null || true
	@echo "Project setup complete!"

# Show help
help:
	@echo "Available commands:"
	@echo "  make install    - Install dependencies"
	@echo "  make server     - Start production server"
	@echo "  make dev        - Start development server"
	@echo "  make setup      - Setup project structure"
	@echo "  make clean      - Clean dependencies"
	@echo "  make reinstall  - Clean and reinstall dependencies"
	@echo "  make test       - Run tests"
	@echo "  make check      - Check system requirements"
	@echo "  make help       - Show this help"