package com.akinevz.agents.dto;

import java.util.List;
import java.util.Map;

public record ClassifyResponse(Map<String, Object> gene, List<Span> spans) {
}
