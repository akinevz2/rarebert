"""HTTP-bound agent interface for propaganda detection experiments."""

from __future__ import annotations

import json
import random
import sys
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from devlib import env_or_arg, parse_kv_args, prompt_text, run


@dataclass(frozen=True)
class Span:
    """Token-indexed propaganda span."""

    start: int
    end: int
    label: str


@dataclass
class Agent:
    """Agent wrapper that delegates all behaviour to a bound Quarkus resource."""

    binding: str
    gene: dict[str, Any]

    @classmethod
    def from_binding(cls, binding: str) -> "Agent":
        """Construct an agent by requesting an initial gene from /init."""
        seed = cls(binding=binding, gene={})
        gene_response = seed.invoke("init", {})
        return cls(binding=binding, gene=extract_gene(gene_response))

    def classify(self, tokens: list[str]) -> list[Span]:
        """Classify token sequence into spans."""
        response = self.invoke("classify", {"gene": self.gene, "tokens": tokens})
        raw_spans = response.get("spans", [])
        if not isinstance(raw_spans, list):
            raise RuntimeError("classify response missing spans[]")

        spans: list[Span] = []
        for raw in raw_spans:
            if not isinstance(raw, dict):
                continue
            spans.append(
                Span(
                    start=int(raw.get("start", 0)),
                    end=int(raw.get("end", 0)),
                    label=str(raw.get("label", "not_propaganda")),
                )
            )

        return spans

    def mutate(self) -> None:
        """Mutate this agent's gene in-place via /mutate."""
        response = self.invoke("mutate", {"gene": self.gene})
        self.gene = extract_gene(response)

    def combine(self, other: "Agent") -> "Agent":
        """Recombine with another agent and return a new child agent."""
        response = self.invoke(
            "recombine",
            {
                "leftGene": self.gene,
                "rightGene": other.gene,
            },
        )
        return Agent(binding=self.binding, gene=extract_gene(response))

    def display_gene(self) -> str:
        """Pretty-print this agent's gene."""
        return json.dumps(self.gene, indent=2, sort_keys=True)

    def invoke(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Invoke one Quarkus method endpoint and return decoded JSON.

        HTTP errors intentionally propagate as exceptions for caller handling.
        """
        base = self.binding.rstrip("/")
        url = f"{base}/{method.lstrip('/')}"
        body = json.dumps(payload).encode("utf-8")
        request = Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urlopen(request) as response:  # nosec B310: local/dev tool boundary
            decoded = json.loads(response.read().decode("utf-8"))

        if not isinstance(decoded, dict):
            raise RuntimeError(f"unexpected non-object response from {url}")
        return decoded

    def maybe_rebind(
        self,
        available_bindings: list[str],
        probability: float,
        rng: random.Random | None = None,
    ) -> bool:
        """Optionally rebind and re-initialize this agent's gene.

        Returns True when rebinding happened.
        """
        if probability <= 0:
            return False

        source = rng or random
        if source.random() >= probability:
            return False

        candidates = [entry for entry in available_bindings if entry]
        if not candidates:
            return False

        self.binding = source.choice(candidates)
        response = self.invoke("init", {})
        self.gene = extract_gene(response)
        return True


def extract_gene(response: dict[str, Any]) -> dict[str, Any]:
    """Extract a gene object from known response shapes."""
    if "gene" in response and isinstance(response["gene"], dict):
        return dict(response["gene"])

    if "data" in response and isinstance(response["data"], dict):
        nested = response["data"].get("gene")
        if isinstance(nested, dict):
            return dict(nested)

    # Allow raw gene responses for minimal services.
    if all(isinstance(k, str) for k in response.keys()):
        return dict(response)

    raise RuntimeError("response does not include a gene object")


def main() -> int:
    print("agent.py has been revoked and is no longer executable via make agent.")
    return 2

    try:
        args = parse_kv_args(sys.argv[1:])
        binding = env_or_arg(args, "BINDING", "http://localhost:8080/rule-agent")
        if not binding:
            binding = prompt_text(
                "Agent binding URL (BINDING)",
                default="http://localhost:8080/rule-agent",
            )

        tokens_value = env_or_arg(args, "TOKENS", "")
        if not tokens_value:
            tokens_value = prompt_text("Token sequence (TOKENS, space-separated)", default="example tokens")
        tokens = [token for token in tokens_value.split() if token]
        if not tokens:
            tokens = ["example", "tokens"]
    except ValueError as exc:
        print(f"Error: {exc}")
        print("Usage: python3 agent.py [BINDING=<url>] [TOKENS='token1 token2 ...']")
        return 2

    try:
        agent = Agent.from_binding(binding)
        spans = agent.classify(tokens)
    except (HTTPError, URLError, RuntimeError, ValueError) as exc:
        print(f"Error: {exc}")
        return 2

    print("Binding:", agent.binding)
    print("Gene:")
    print(agent.display_gene())
    print("Spans:")
    for span in spans:
        print(f"  - start={span.start} end={span.end} label={span.label}")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(main))
