# rarebert sources

All source code lives under `src/` and is grouped by language:

```
src/
├── python/    # The Python pipeline (data-loader, enrich_bow, join-stages, ...)
├── java/      # Maven project (Java 21, groupId=kn253, artifactId=rarebert)
└── scala/     # sbt project (Scala 3.7.x, build.sbt + project/build.properties)
```

The top-level `Makefile` autodiscovers every `*.py` under `src/python/` and
emits one recipe per target. Regenerate it with:

```bash
make bootstrap
```

## Adding a new Python module

```bash
make add MODULE=my-new-stage
```

The scaffolder writes the new module under `src/python/` and refreshes the
top-level `Makefile`.

## Java (Maven)

```bash
cd src/java
mvn -q compile exec:java -Dexec.mainClass=kn253.App
```

## Scala (sbt)

```bash
cd src/scala
sbt run
sbt test
```
