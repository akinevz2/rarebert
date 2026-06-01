## Quarkus Service Contract
 
The Quarkus application is a **pure functional projection**. It holds no state
between requests. All endpoints receive a complete gene + context payload and
return a transformed result. No endpoint has side effects outside the response.
 
All resource classes must follow this pattern:
 
```java
@Path("/rule-agent")          // or /weight-agent, etc.
public class RuleAgentResource {
 
    @POST @Path("/classify")
    @RunOnVirtualThread
    public ClassifyResponse classify(ClassifyRequest req) { ... }
 
    @POST @Path("/mutate")
    @RunOnVirtualThread
    public GeneResponse mutate(GeneRequest req) { ... }
 
    @POST @Path("/recombine")
    @RunOnVirtualThread
    public GeneResponse recombine(RecombineRequest req) { ... }
 
    @POST @Path("/init")
    @RunOnVirtualThread
    public GeneResponse init() { ... }
}
```
 
`@RunOnVirtualThread` is mandatory on every endpoint — do not use platform threads.
All request/response types are plain records with Jackson serialisation.
 
### Span representation (shared across Python and Java)
```json
{ "start": 3, "end": 7, "label": "repetition" }
```
Spans are token-indexed, end-exclusive, and non-overlapping within a single
agent's output. Labels are one of the ten defined propaganda technique strings
or `"not_propaganda"`.
