install:
	npm install
remove-node-modules:
	rm -rf node_modules

tts:
	cd tts && $(MAKE)

stt:
	cd stt && $(MAKE)

vllm:
	cd vllm && $(MAKE)