# Auto-generated Makefile

.PHONY: add check commit create diff edit jump memo reload undo implement help open


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

create:
	node index.js create

diff:
	node index.js diff

edit:
	node index.js edit

jump:
	node index.js jump

memo:
	node index.js memo

reload:
	node index.js reload
	  @if [ -n "$$FORGET" ]; then rm -f .last-module; fi

undo:
	node index.js undo

implement:
	@file=$$(cat .last-module); \
	  [ -n "$$file" ] || { echo 'Run make add first'; exit 1; }; \
	  opencode run "Implement the module in $$file" --auto -m $(MODEL)

help:
	node index.js

open:
	node index.js open
