package com.akinevz.templates;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

@Path("/todo")
public class ResourceTemplate {
    @GET
    @Produces(MediaType.TEXT_PLAIN)
    public String ping() {
        // TODO: implement resource behavior
        return "ok";
    }
}
