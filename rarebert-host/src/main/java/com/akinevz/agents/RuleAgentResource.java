package com.akinevz.agents;

import java.util.*;
import java.util.concurrent.ThreadLocalRandom;

import com.akinevz.agents.dto.*;

import io.smallrye.common.annotation.RunOnVirtualThread;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

@Path("/rule-agent")
public class RuleAgentResource {

    @POST
    @Path("/init")
    @RunOnVirtualThread
    public GeneResponse init() {
        final Map<String, Object> gene = new HashMap<>();
        gene.put("kind", "rule");
        gene.put("threshold", 1.0d);
        gene.put(
                "rules",
                Map.of(
                        "loaded_language", List.of("annihilated", "devastating", "triumphant"),
                        "doubt", List.of("so-called", "cannot", "trusted"),
                        "flag_waving", List.of("our", "america", "american")));
        return new GeneResponse(gene);
    }

    @POST
    @Path("/classify")
    @RunOnVirtualThread
    public ClassifyResponse classify(final ClassifyRequest req) {
        final Map<String, Object> gene = GeneUtils.mutableGene(req.gene());
        final Map<String, List<String>> rules = GeneUtils.getStringListMap(gene, "rules");
        final double threshold = GeneUtils.getDouble(gene, "threshold", 1.0d);
        final List<String> tokens = req.tokens() == null ? List.of() : req.tokens();
        final List<String> lowered = GeneUtils.lowerTokens(tokens);

        final List<Span> spans = new ArrayList<>();
        for (int i = 0; i < lowered.size(); i++) {
            final String token = lowered.get(i);
            String bestLabel = null;
            int bestHits = 0;

            for (final Map.Entry<String, List<String>> entry : rules.entrySet()) {
                final int hits = entry.getValue().contains(token) ? 1 : 0;
                if (hits > bestHits) {
                    bestHits = hits;
                    bestLabel = entry.getKey();
                }
            }

            if (bestLabel != null && bestHits >= threshold) {
                spans.add(new Span(i, i + 1, bestLabel));
            }
        }

        if (spans.isEmpty() && !tokens.isEmpty()) {
            spans.add(new Span(0, tokens.size(), "not_propaganda"));
        }
        return new ClassifyResponse(gene, spans);
    }

    @POST
    @Path("/mutate")
    @RunOnVirtualThread
    public GeneResponse mutate(final GeneRequest req) {
        final Map<String, Object> gene = GeneUtils.mutableGene(req.gene());
        final Map<String, List<String>> rules = GeneUtils.getStringListMap(gene, "rules");
        if (rules.isEmpty()) {
            return init();
        }

        final List<String> labels = new ArrayList<>(rules.keySet());
        final String label = labels.get(ThreadLocalRandom.current().nextInt(labels.size()));
        final List<String> words = new ArrayList<>(rules.getOrDefault(label, List.of()));

        if (!words.isEmpty() && ThreadLocalRandom.current().nextBoolean()) {
            words.remove(ThreadLocalRandom.current().nextInt(words.size()));
        } else {
            words.add(randomRuleToken());
        }
        rules.put(label, words);
        gene.put("rules", rules);

        final double threshold = GeneUtils.getDouble(gene, "threshold", 1.0d);
        final double mutated = Math.max(1.0d, Math.min(2.0d, threshold + jitter()));
        gene.put("threshold", mutated);
        return new GeneResponse(gene);
    }

    @POST
    @Path("/recombine")
    @RunOnVirtualThread
    public GeneResponse recombine(final RecombineRequest req) {
        final Map<String, Object> left = GeneUtils.mutableGene(req.leftGene());
        final Map<String, Object> right = GeneUtils.mutableGene(req.rightGene());

        final Map<String, List<String>> leftRules = GeneUtils.getStringListMap(left, "rules");
        final Map<String, List<String>> rightRules = GeneUtils.getStringListMap(right, "rules");
        final Map<String, List<String>> combined = new HashMap<>();

        for (final String label : leftRules.keySet()) {
            final List<String> words = new ArrayList<>(leftRules.getOrDefault(label, List.of()));
            for (final String rightWord : rightRules.getOrDefault(label, List.of())) {
                if (!words.contains(rightWord)) {
                    words.add(rightWord);
                }
            }
            combined.put(label, words);
        }

        for (final String label : rightRules.keySet()) {
            combined.putIfAbsent(label, new ArrayList<>(rightRules.get(label)));
        }

        final Map<String, Object> out = new HashMap<>();
        out.put("kind", "rule");
        out.put("rules", combined);
        final double leftThreshold = GeneUtils.getDouble(left, "threshold", 1.0d);
        final double rightThreshold = GeneUtils.getDouble(right, "threshold", 1.0d);
        out.put("threshold", (leftThreshold + rightThreshold) / 2.0d);
        return new GeneResponse(out);
    }

    private static double jitter() {
        return ThreadLocalRandom.current().nextDouble(-0.25d, 0.25d);
    }

    private static String randomRuleToken() {
        final List<String> pool = List.of(
                "disaster", "threat", "patriots", "betrayal", "stunning", "corrupt", "heroic");
        return pool.get(ThreadLocalRandom.current().nextInt(pool.size()));
    }
}
