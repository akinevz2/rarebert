package com.akinevz.agents;

import java.util.*;
import java.util.concurrent.ThreadLocalRandom;

import com.akinevz.agents.dto.*;

import io.smallrye.common.annotation.RunOnVirtualThread;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

@Path("/weight-agent")
public class WeightAgentResource {

    @POST
    @Path("/init")
    @RunOnVirtualThread
    public GeneResponse init() {
        final Map<String, Object> gene = new HashMap<>();
        gene.put("kind", "weight");
        gene.put("bias", 0.0d);
        gene.put(
                "weights",
                Map.of(
                        "loaded_language", 1.2d,
                        "fear", 1.0d,
                        "patriot", 0.9d,
                        "threat", 1.1d,
                        "so-called", 0.8d,
                        "annihilated", 1.3d));
        return new GeneResponse(gene);
    }

    @POST
    @Path("/classify")
    @RunOnVirtualThread
    public ClassifyResponse classify(final ClassifyRequest req) {
        final Map<String, Object> gene = GeneUtils.mutableGene(req.gene());
        final Map<String, Double> weights = GeneUtils.getDoubleMap(gene, "weights");
        final double bias = GeneUtils.getDouble(gene, "bias", 0.0d);
        final List<String> tokens = req.tokens() == null ? List.of() : req.tokens();

        final List<String> lowered = GeneUtils.lowerTokens(tokens);
        double bestScore = Double.NEGATIVE_INFINITY;
        int bestIndex = -1;
        for (int i = 0; i < lowered.size(); i++) {
            final String token = lowered.get(i);
            final double score = bias + weights.getOrDefault(token, 0.0d);
            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        final List<Span> spans = new ArrayList<>();
        if (tokens.isEmpty()) {
            return new ClassifyResponse(gene, spans);
        }

        final String label = bestScore > 0.5d ? "loaded_language" : "not_propaganda";
        if ("not_propaganda".equals(label)) {
            spans.add(new Span(0, tokens.size(), label));
        } else {
            spans.add(new Span(bestIndex, bestIndex + 1, label));
        }
        return new ClassifyResponse(gene, spans);
    }

    @POST
    @Path("/mutate")
    @RunOnVirtualThread
    public GeneResponse mutate(final GeneRequest req) {
        final Map<String, Object> gene = GeneUtils.mutableGene(req.gene());
        final Map<String, Double> weights = new HashMap<>(GeneUtils.getDoubleMap(gene, "weights"));
        if (weights.isEmpty()) {
            return init();
        }

        final List<String> keys = new ArrayList<>(weights.keySet());
        final String key = keys.get(ThreadLocalRandom.current().nextInt(keys.size()));
        final double current = weights.getOrDefault(key, 0.0d);
        final double mutated = current + ThreadLocalRandom.current().nextDouble(-0.4d, 0.4d);
        weights.put(key, mutated);

        if (ThreadLocalRandom.current().nextDouble() < 0.2d) {
            final String newToken = randomToken();
            weights.put(newToken, ThreadLocalRandom.current().nextDouble(-0.3d, 1.3d));
        }

        final double bias = GeneUtils.getDouble(gene, "bias", 0.0d);
        gene.put("bias", bias + ThreadLocalRandom.current().nextDouble(-0.1d, 0.1d));
        gene.put("weights", weights);
        gene.put("kind", "weight");
        return new GeneResponse(gene);
    }

    @POST
    @Path("/recombine")
    @RunOnVirtualThread
    public GeneResponse recombine(final RecombineRequest req) {
        final Map<String, Object> left = GeneUtils.mutableGene(req.leftGene());
        final Map<String, Object> right = GeneUtils.mutableGene(req.rightGene());
        final Map<String, Double> leftWeights = GeneUtils.getDoubleMap(left, "weights");
        final Map<String, Double> rightWeights = GeneUtils.getDoubleMap(right, "weights");

        final Map<String, Double> outWeights = new HashMap<>(leftWeights);
        for (final Map.Entry<String, Double> entry : rightWeights.entrySet()) {
            outWeights.merge(entry.getKey(), entry.getValue(), (a, b) -> (a + b) / 2.0d);
        }

        final Map<String, Object> out = new HashMap<>();
        out.put("kind", "weight");
        out.put("weights", outWeights);
        final double leftBias = GeneUtils.getDouble(left, "bias", 0.0d);
        final double rightBias = GeneUtils.getDouble(right, "bias", 0.0d);
        out.put("bias", (leftBias + rightBias) / 2.0d);
        return new GeneResponse(out);
    }

    private static String randomToken() {
        final List<String> pool = List.of(
                "danger", "elite", "nation", "urgent", "radical", "enemy", "freedom");
        return pool.get(ThreadLocalRandom.current().nextInt(pool.size())).toLowerCase(Locale.ROOT);
    }
}
