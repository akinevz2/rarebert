# Auto-generated Makefile

.PHONY: help add check git implement jump memo open reload undo


help:
	node index.js


add:
	@node index.js add; \
	  [ -f .last-module ] || exit 1; \
	  file=$$(cat .last-module); \
	  echo "Created: $$file"; \
	  $${EDITOR:-nano} $$EDITOR_FLAGS "$$file"; \
	  opencode run "Implement the module in $$file" --auto -m ollama/glm-5.2:cloud


check:
	node index.js check


git:
	node index.js git


implement:
	@file=$$(cat .last-module); \
	  [ -n "$$file" ] || { echo 'Run make add first'; exit 1; }; \
	  opencode run "Implement the module in $$file" --auto -m ollama/glm-5.2:cloud


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
