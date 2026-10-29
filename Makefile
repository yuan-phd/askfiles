# Thin wrappers around the npm scripts in package.json.
.PHONY: build test lint clean

build:
	npm run build

test:
	npm test

lint:
	npm run lint

# Removes build outputs only. Installed node_modules and patched upstream files are left alone;
# reverting patches is git checkout -- upstream/.
clean:
	rm -rf dist release upstream/server/public upstream/frontend/dist
