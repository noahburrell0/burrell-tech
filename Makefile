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
	@docker exec $(CONTAINER) sh -c 'echo "server { \
		listen 80; \
		server_name _; \
		root /usr/share/nginx/html; \
		index index.html; \
		location / { try_files \$$uri \$$uri/ @rm-ext; } \
		location ~ \.html\$$ { try_files \$$uri =404; } \
		location @rm-ext { rewrite ^(.*)\$$ \$$1.html last; } \
	}" > /etc/nginx/conf.d/default.conf && nginx -s reload'
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
