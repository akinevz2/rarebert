package com.akinevz.agents.dto;

import java.util.Map;

public record RecombineRequest(Map<String, Object> leftGene, Map<String, Object> rightGene) {
}
