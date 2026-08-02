# Auto-generated Makefile

MODEL ?= ollama/glm-5.2:cloud

.PHONY: help add check commit implement jump memo open reload undo


help:
	node index.js


add:
	@node index.js add; \
	  [ -f .last-module ] || exit 1; \
	  file=$$(cat .last-module); \
	  echo "Created: $$file"; \
	  git add -A; \
	  $${EDITOR:-nano} $$EDITOR_FLAGS "$$file"; \
	  opencode run "Implement the module in $$file" --auto -m $(MODEL)


check:
	node index.js check


commit:
	node index.js commit


implement:
	@file=$$(cat .last-module); \
	  [ -n "$$file" ] || { echo 'Run make add first'; exit 1; }; \
	  opencode run "Implement the module in $$file" --auto -m $(MODEL)


jump:
	node index.js jump


memo:
	node index.js memo


open:
	node index.js open


reload:
	node index.js reload
	  @if [ -n "$$FORGET" ]; then rm -f .last-module; fi


undo:
	node index.js undo
