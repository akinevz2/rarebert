# Auto-generated Makefile

.PHONY: help reload add edit implement implement list


help:
	node index.js


reload:
	node index.js reload
	@rm -f .last-module


add:
	@node index.js add; \
	  [ -f .last-module ] || exit 1; \
	  file=$$(cat .last-module); \
	  echo "Created: $$file"; \
	  $${EDITOR:-nano} $$EDITOR_FLAGS "$$file"; \
	  opencode run "Implement the module in $$file" -m ollama/glm-5.2:cloud --file "$$file"


edit:
	@file=$$(cat .last-module); \
	  [ -n "$$file" ] || { echo 'Run make add first'; exit 1; }; \
	  $${EDITOR:-nano} $$EDITOR_FLAGS "$$file"


implement:
	@file=$$(cat .last-module); \
	  [ -n "$$file" ] || { echo 'Run make add first'; exit 1; }; \
	  opencode run "Implement the module in $$file" -m ollama/glm-5.2:cloud --file "$$file"

list:
	node index.js list
