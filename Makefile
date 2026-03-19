PORT      ?= 8080
CONTAINER  = burrell-tech-dev
SITE_DIR   = $(shell pwd)/dist

.PHONY: start stop build watch i18n clean

build:
	npm install
	mkdir -p dist/css dist/js dist/fonts
	npm run-script build
	cp node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 dist/fonts/
	sh scripts/rebuild.sh
	npx @11ty/eleventy --quiet

i18n:
	node scripts/build-i18n.js

watch:
	node scripts/watch.js

clean:
	mkdir -p dist
	rm -rf dist/*

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
		absolute_redirect off; \
		location / { try_files \$$uri \$$uri/ @rm-ext; } \
		location ~ \.html\$$ { try_files \$$uri =404; } \
		location @rm-ext { rewrite ^(.*)\$$ \$$1.html last; } \
	}" > /etc/nginx/conf.d/default.conf && nginx -s reload'
	@echo "Serving at http://localhost:$(PORT)"

stop:
	docker rm -f $(CONTAINER)
