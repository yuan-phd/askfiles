# Thin wrappers around the npm scripts in package.json.
.PHONY: build test lint clean

build:
	npm run build

test:
	npm test

lint:
	npm run lint

# Removes build outputs only. Installed node_modules and resources/ollama are left alone, and so is
# upstream-build/ (the patched, installed copy of upstream/, about 2.4 GB; remove it by hand to
# rebuild it from scratch). upstream/ itself is never written to.
clean:
	rm -rf dist release release-test upstream-build/package upstream-build/run/server/public upstream-build/run/frontend/dist
