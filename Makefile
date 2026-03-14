PORT      ?= 8080
CONTAINER  = burrell-tech-dev
SITE_DIR   = $(shell pwd)

.PHONY: start stop setup build watch

start:
	docker rm -f $(CONTAINER) 2>/dev/null || true
	docker run -d \
		--name $(CONTAINER) \
		-p $(PORT):80 \
		-v $(SITE_DIR):/usr/share/nginx/html:ro \
		nginx:alpine
	@echo "Serving at http://localhost:$(PORT)"

stop:
	docker rm -f $(CONTAINER)

build:
	npm install
	npm run-script build
	mkdir -p fonts
	cp node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 fonts/

watch:
	npm run-script watch
