package com.akinevz.agents;

import java.util.*;

final class GeneUtils {
    private GeneUtils() {
    }

    static Map<String, Object> mutableGene(final Map<String, Object> gene) {
        if (gene == null) {
            return new HashMap<>();
        }
        return new HashMap<>(gene);
    }

    static double getDouble(final Map<String, Object> gene, final String key, final double fallback) {
        final Object value = gene.get(key);
        if (value instanceof final Number n) {
            return n.doubleValue();
        }
        if (value instanceof final String s) {
            try {
                return Double.parseDouble(s);
            } catch (final NumberFormatException ignored) {
                return fallback;
            }
        }
        return fallback;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Double> getDoubleMap(final Map<String, Object> gene, final String key) {
        final Object value = gene.get(key);
        final Map<String, Double> out = new HashMap<>();
        if (value instanceof final Map<?, ?> rawMap) {
            for (final Map.Entry<?, ?> entry : rawMap.entrySet()) {
                final String mapKey = String.valueOf(entry.getKey());
                final Object rawValue = entry.getValue();
                if (rawValue instanceof final Number n) {
                    out.put(mapKey, n.doubleValue());
                }
            }
        } else if (value instanceof final HashMap<?, ?> rawHash) {
            for (final Map.Entry<?, ?> entry : rawHash.entrySet()) {
                final String mapKey = String.valueOf(entry.getKey());
                final Object rawValue = entry.getValue();
                if (rawValue instanceof final Number n) {
                    out.put(mapKey, n.doubleValue());
                }
            }
        }
        return out;
    }

    static Map<String, List<String>> getStringListMap(final Map<String, Object> gene, final String key) {
        final Object value = gene.get(key);
        final Map<String, List<String>> out = new HashMap<>();
        if (!(value instanceof final Map<?, ?> rawMap)) {
            return out;
        }

        for (final Map.Entry<?, ?> entry : rawMap.entrySet()) {
            final String mapKey = String.valueOf(entry.getKey());
            final Object listValue = entry.getValue();
            final List<String> values = new ArrayList<>();
            if (listValue instanceof final Iterable<?> iterable) {
                for (final Object item : iterable) {
                    values.add(String.valueOf(item).toLowerCase(Locale.ROOT));
                }
            }
            out.put(mapKey, values);
        }

        return out;
    }

    static List<String> lowerTokens(final List<String> tokens) {
        if (tokens == null) {
            return List.of();
        }
        final List<String> lowered = new ArrayList<>(tokens.size());
        for (final String token : tokens) {
            lowered.add(token == null ? "" : token.toLowerCase(Locale.ROOT));
        }
        return lowered;
    }
}
