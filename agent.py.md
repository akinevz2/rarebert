## Agent Interface (`agent.py`)
 
Every agent holds a single binding: a base URL string pointing to one of the
Quarkus resource paths. All behaviour is delegated over HTTP to that endpoint.
The agent itself is stateless except for its gene representation and its binding.
 
```python
class Agent:
    binding: str          # e.g. "http://localhost:8080/rule-agent"
    gene: dict            # opaque — structure defined by the bound Java resource
 
    def classify(self, tokens: list[str]) -> list[Span]: ...
    def mutate(self) -> None: ...
    def combine(self, other: Agent) -> Agent: ...
    def display_gene(self) -> str: ...
    def invoke(self, method: str, payload: dict) -> dict: ...
```
 
`invoke` is the single HTTP boundary. Every other method constructs a payload and
calls `invoke`. HTTP errors must propagate as exceptions — do not swallow them.
 
Lateral transfer: on each generation, each agent has a small configurable
probability of re-binding to a randomly selected available Quarkus resource path.
Re-binding replaces `self.binding` and re-initialises `self.gene` via a
`POST /{binding}/init` call.
