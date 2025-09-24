# ===== STT Makefile =====
PYTHON       := python3
SETUP_SCRIPT := setup_model.py
CHECKPOINT_DIR := checkpoints/stt-1b-en_fr
STT_SERVER   := stt_server.js

.PHONY: all npm-install install setup clean start-server full

# -----------------------------
# Default target: setup + optional npm
all: npm-install setup

# -----------------------------
# Node.js dependencies
npm-install:
	@echo "Installing Node.js dependencies..."
	npm install

# -----------------------------
# Python dependencies + model setup
install:
	@echo "Installing Python dependencies and STT model..."
	$(PYTHON) -m pip install --upgrade pip
	$(PYTHON) $(SETUP_SCRIPT)

# -----------------------------
# Setup (alias for install)
setup: install start-server
	@echo "STT setup complete! Checkpoints in $(CHECKPOINT_DIR)"

# -----------------------------
# Clean checkpoints
clean:
	@echo "Cleaning STT checkpoints..."
	rm -rf $(CHECKPOINT_DIR)
	@echo "Cleaned."

# -----------------------------

# Start STT server
start-server:
	@echo "Starting STT server..."
	node $(STT_SERVER)

# -----------------------------
# Full workflow: setup -> server
full: setup start-server
	@echo "Full STT setup, server running"
