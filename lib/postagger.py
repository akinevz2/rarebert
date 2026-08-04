#!/usr/bin/env python3
"""
postagger module - part-of-speech tagger API scaffold.

Terse API spec (implementations deferred):
    tag(tokens)          -> list[(token, tag)]
    tag_sentence(text)   -> list[(token, tag)]
    tags_for(text)       -> list[tag]
    batch_tag(sentences) -> list[list[(token, tag)]]
    set_model(name)      -> None
    supported_tags()     -> set[str]
    confidence(tokens)   -> list[(token, tag, float)]
    tokenize(text)       -> list[str]
"""

from typing import List, Tuple, Sequence, Set

SUPPORTED_TAGS: Set[str] = set()

def tokenize(text: str) -> List[str]:
    """Split raw text into a list of tokens. Not implemented."""
    raise NotImplementedError

def tag(tokens: Sequence[str]) -> List[Tuple[str, str]]:
    """Tag a pre-tokenized sequence. Returns (token, tag) pairs. Not implemented."""
    raise NotImplementedError

def tag_sentence(text: str) -> List[Tuple[str, str]]:
    """Tokenize and tag a raw sentence string. Not implemented."""
    raise NotImplementedError

def tags_for(text: str) -> List[str]:
    """Return only the tag sequence for a raw sentence. Not implemented."""
    raise NotImplementedError

def batch_tag(sentences: Sequence[Sequence[str]]) -> List[List[Tuple[str, str]]]:
    """Tag multiple pre-tokenized sentences. Not implemented."""
    raise NotImplementedError

def confidence(tokens: Sequence[str]) -> List[Tuple[str, str, float]]:
    """Tag with per-token confidence scores. Not implemented."""
    raise NotImplementedError

def set_model(name: str) -> None:
    """Select the tagging model/backend by name. Not implemented."""
    raise NotImplementedError

def supported_tags() -> Set[str]:
    """Return the set of tags the current model can emit. Not implemented."""
    raise NotImplementedError