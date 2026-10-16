# Release workflow for Flowly (the Paseo plugin). Run `make help`.
#
#   make release VERSION=1.1.0     check, bump, commit, tag, push, publish to npm, GitHub release
#   make release VERSION=1.1.0 DRY_RUN=1    print every outward step instead of running it
#
# Every outward step (push, npm publish, GitHub release) asks first; pass YES=1 to skip the questions.
# npm credentials are never stored: export NPM_TOKEN (granular token that bypasses 2FA) or use `npm login`;
# NPM_OTP=123456 supplies a one-time code. The token only lives in a temporary file during the publish.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PKG    := $(shell node -p "require('./package.json').name")
CUR    := $(shell node -p "require('./package.json').version")
BRANCH := main
# With DRY_RUN=1 outward commands are printed, not run.
RUN    := $(if $(DRY_RUN),echo [dry-run],)

# $(call confirm,question)
define confirm
@if [ -z "$(YES)" ] && [ -z "$(DRY_RUN)" ]; then read -r -p "$(1) [y/N] " a; [ "$$a" = y ] || { echo "aborted"; exit 1; }; fi
endef

.PHONY: help check pack verify-clean bump tag push publish wait-npm github-release release registry install-local reload

help: ## Show this help
	@echo "Flowly release workflow (package $(PKG)@$(CUR))"; echo
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  make %-15s %s\n", $$1, $$2}'

check: ## Typecheck and run the tests
	npm run typecheck
	npm test

pack: ## List what the npm package would contain (nothing is published)
	npm pack --dry-run --ignore-scripts

verify-clean: ## Fail unless on main, with a clean tree, in sync with origin
	@test "$$(git branch --show-current)" = "$(BRANCH)" || { echo "not on $(BRANCH)"; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "working tree is not clean:"; git status --short; exit 1; }
	@git fetch -q origin
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/$(BRANCH))" || { echo "HEAD differs from origin/$(BRANCH): push or pull first"; exit 1; }

bump: ## Set the version in package.json and the lockfile (VERSION=x.y.z)
	@test -n "$(VERSION)" || { echo "usage: make bump VERSION=x.y.z"; exit 1; }
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$$' || { echo "VERSION must look like 1.2.3"; exit 1; }
	@if git rev-parse -q --verify "refs/tags/v$(VERSION)" >/dev/null; then echo "tag v$(VERSION) already exists"; exit 1; fi
	npm version "$(VERSION)" --no-git-tag-version --ignore-scripts

tag: ## Commit the version bump and create the annotated tag for the current version
	git add package.json package-lock.json
	git commit -q -m "Release v$(CUR)"$$'\n\n'"Co-Authored-By: Codex claude-sonnet-5-5 <noreply@anthropic.com>"
	git tag -a "v$(CUR)" -m "Flowly v$(CUR): the agent-native workflow for Paseo"

push: ## Push main and the tag for the current version to origin
	$(call confirm,Push $(BRANCH) and v$(CUR) to origin?)
	$(RUN) git push origin $(BRANCH) "v$(CUR)"

publish: ## Publish the current version to npm, then wait until it is live
	$(call confirm,Publish $(PKG)@$(CUR) to npm?)
	@set -e; t=$$(mktemp); trap 'rm -f "$$t"' EXIT; \
	if [ -n "$$NPM_TOKEN" ]; then printf '//registry.npmjs.org/:_authToken=%s\n' "$$NPM_TOKEN" > "$$t"; export NPM_CONFIG_USERCONFIG="$$t"; fi; \
	$(RUN) npm publish --ignore-scripts $${NPM_OTP:+--otp=$$NPM_OTP}
	@if [ -z "$(DRY_RUN)" ]; then $(MAKE) --no-print-directory wait-npm; fi

wait-npm: ## Wait until npm shows the current version (new versions can take a few minutes)
	@for i in $$(seq 1 30); do \
	  v=$$(npm view "$(PKG)@$(CUR)" version 2>/dev/null || true); \
	  if [ "$$v" = "$(CUR)" ]; then echo "$(PKG)@$(CUR) is live on npm"; exit 0; fi; \
	  echo "waiting for npm ($$i/30)..."; sleep 10; \
	done; echo "not visible on npm yet: check https://www.npmjs.com/package/$(PKG)"; exit 1

github-release: ## Create the GitHub release for the current tag (generated notes)
	$(call confirm,Create GitHub release v$(CUR)?)
	$(RUN) gh release create "v$(CUR)" --verify-tag --title "Flowly v$(CUR)" --generate-notes

release: ## Full release: make release VERSION=x.y.z [DRY_RUN=1] [YES=1] [NO_GH_RELEASE=1]
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=x.y.z"; exit 1; }
	@$(MAKE) --no-print-directory verify-clean
	@$(MAKE) --no-print-directory check
	@$(RUN) $(MAKE) --no-print-directory bump VERSION=$(VERSION)
	@$(RUN) $(MAKE) --no-print-directory tag
	@$(MAKE) --no-print-directory push
	@$(MAKE) --no-print-directory publish
	@if [ -z "$(NO_GH_RELEASE)" ]; then $(MAKE) --no-print-directory github-release; fi
	@$(MAKE) --no-print-directory registry

registry: ## Print how to update the Paseo registry listing (Git updates there are manual)
	@echo
	@echo "The Paseo plugin registry pins a commit and does not follow new releases by itself."
	@echo "To list this one, open a new submission: https://github.com/getpaseo/plugins/issues/new/choose"
	@echo "  Source: https://github.com/JasprW/flowly   Commit: $$(git rev-parse HEAD)"

install-local: ## Install this checkout as the local plugin (development)
	paseo plugin install "$$PWD" --id flowly

reload: ## Reload the local plugin after changes (typechecks first)
	npm run typecheck
	paseo plugin reload flowly
