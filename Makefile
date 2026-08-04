# Auto-generated Makefile: a pure index of `node index.js <name>` targets

.DEFAULT_GOAL := list

.PHONY: list add article backend check commit diff edit implement languages memo project reload run undo install deps opencode

list:
	node index.js


add:
	node index.js add

article:
	node index.js article

backend:
	node index.js backend

check:
	node index.js check

commit:
	node index.js commit

diff:
	node index.js diff

edit:
	node index.js edit

implement:
	node index.js implement

languages:
	node index.js languages

memo:
	node index.js memo

project:
	node index.js project

reload:
	node index.js reload

run:
	node index.js run

undo:
	node index.js undo

install:
	npm install

deps:
	npm install

opencode:
	./node_modules/opencode-ai/bin/opencode.exe $(ARGS)
