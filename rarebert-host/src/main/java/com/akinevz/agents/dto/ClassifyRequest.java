package com.akinevz.agents.dto;

import java.util.List;
import java.util.Map;

public record ClassifyRequest(Map<String, Object> gene, List<String> tokens) {
}
