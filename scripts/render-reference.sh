#!/bin/sh
# Re-render the reference admin forms from the spatial-service GSP views (see reference/<version>/NOTICE).
set -eu
V=${1:-3.1.0}
D=reference/$V
R="node scripts/render-gsp.mjs"
$R $D/layer.gsp '{"id":"1790000000000","raw_id":"","name":"mcp_poc_regions","displayname":"mcp_poc_regions","type":"Contextual","domain":"Terrestrial","enabled":true,"has_layer":false,"minlongitude":-10,"maxlongitude":5,"minlatitude":35,"maxlatitude":44,"classifications":["Area Management > Biodiversity","Political > States"],"licence_level":1}' > $D/layer-new.html
$R $D/layer.gsp '{"id":"1790000000000","raw_id":"1234","name":"mcp_poc_regions","displayname":"MCP POC regions","type":"Contextual","domain":"Terrestrial","enabled":true,"has_layer":true,"layer_id":"1234","classification1":"Area Management","licence_level":2}' > $D/layer-existing.html
$R $D/field.gsp '{"id":"1234","name":"MCP POC regions","type":"c","columns":["NAME","CODE","the_geom"],"requestedId":"","indb":true,"namesearch":true,"intersect":false,"defaultlayer":true}' > $D/field-new.html
