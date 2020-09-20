const elasticsearch = require("elasticsearch");

let host;
if (process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD) {
  host = `https://${process.env.ELASTICSEARCH_USERNAME}:${process.env.ELASTICSEARCH_PASSWORD}@${process.env.ELASTICSEARCH_DOMAIN}`;
} else {
  host = `http://${process.env.ELASTICSEARCH_DOMAIN}`;
}

const client = new elasticsearch.Client({
  host,
});


async function search(params, type = "all", options) {
  const searchFn =
    type === "all" ? doMSearch(params) : doTypedSearch(params, type, options);
  return await searchFn;
}

async function doMSearch(params) {
  const emptyParams = Object.keys(params).length === 0;
  const lines = emptyParams ? getRandomQueries() : getQueries(params);

  const { responses } = await client.msearch({
    body: lines.join("\n"),
  });

  return {
    artists: getFormattedResultsObject(responses[0]),
    albums: getFormattedResultsObject(responses[1]),
    tracks: getFormattedResultsObject(responses[2]),
    documents: getFormattedResultsObject(responses[3]),
  };
}

function getRandomQuery() {
  return {
    "query": {
      "function_score": {
        "random_score": {}
      }
    }
  };
}

function getRandomQueries() {
  const queryString = JSON.stringify(getRandomQuery());
  
  return [
    '{ "index": "artist" }',
    queryString,
    '{ "index": "album" }',
    queryString,
    '{ "index": "track" }',
    queryString,
  ];
}

function getQueries(params) {
  return [
    '{ "index": "artist" }',
    JSON.stringify(buildArtistSearch(params)),
    '{ "index": "album" }',
    JSON.stringify(buildAlbumSearch(params)),
    '{ "index": "track" }',
    JSON.stringify(buildTrackSearch(params)),
    '{ "index": "document" }',
    JSON.stringify(buildDocumentSearch(params)),
  ]; 
}

function buildQueryObj({ from = 0, size = 10 } = {}) {
  return {
    from: from,
    size: size,
    query: {
      bool: {},
    },
  };
}

function buildArtistSearch(params, options) {
  if(!options) {
    options = {
      size: 5,
    };
  }
  const queryObj = buildQueryObj(options);
  
  if(params.term) {
    Object.assign(queryObj.query.bool, buildFuzzyMultiMatch(params.term, ["normalized_name", "name"]));
  }

  return queryObj;
}


function buildAlbumSearch(params, options) {
  const queryObj = buildQueryObj(options);

  if(params.term) {
    Object.assign(queryObj.query.bool, buildFuzzyMultiMatch(params.term, [
      "normalized_title^3",
      "title^2",
      "album_artist.normalized_name",
      "album_artist.name",
      "label",
    ]));
  }
  
  if(params.album) {
    queryObj.query.bool.filter = buildAlbumFilters(params.album);
  }
  
  return queryObj;
}

function buildAlbumFilters(params, prefix = "") {
  const filters = [];
  for(const key in params) {
    switch(key) {
      case "rotation":
        if(params.rotation !== "any") {
          filters.push(buildQuery("terms", `${prefix}current_tags`, [params.rotation]));
        }
        break;
      case "local":
        if(params.local !== "any") {
          filters.push(buildQuery("terms", `${prefix}current_tags`, [params.local]));
        }
        break;
      case "is_compilation":
        filters.push(buildQuery("match", `${prefix}${key}`, params[key]));
        break;
      default:
        filters.push(buildQuery("match_phrase", `${prefix}${key}`, params[key]));
    }
  }
  console.log(filters);
  return filters;
}

function buildTrackSearch(params, options) {
  const queryObj = buildQueryObj(options);
  
  if(params.term) {
    Object.assign(queryObj.query.bool, buildFuzzyMultiMatch(params.term, [
      "normalized_title^4",
      "title^3",
      "track_artist.normalized_name^2",
      "track_artist.name^2",
      "album.album_artist.normalized_name",
      "album.album_artist.name",
      "album.normalized_title",
      "album.title",
    ]));
  }

  if(params.track) {
    const filters = [];
    
    if(params.track) {
      if(params.track.duration_ms) {      
        const durationFilter = {
          range: {
            duration_ms: params.track.duration_ms
          }
        };
  
        if(durationFilter.range.duration_ms.lte === '') {
          delete durationFilter.range.duration_ms.lte;
        }

        filters.push(durationFilter);
      }

      if(params.track.is_recommended) {
        filters.push({ "match": { "current_tags": "recommended" } });
      }
    }

    if(params.track.album) {
      filters.push(buildAlbumFilters(params.track.album, "album."));
    }
  
    queryObj.query.bool.filter = filters;
  }

  return queryObj;
}

function buildDocumentSearch(params, { from = 0, size = 10 } = {}) {
  return {
    from: from,
    size: size,
    query: {
      multi_match: {
        query: params.term,
        fields: ["normalized_unsafe_text", "unsafe_text"],
      },
    },
    highlight: {
      fields: {
        "*unsafe_text": {},
      },
      number_of_fragments: 3,
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
    },
  };
}

function buildFuzzyMultiMatch(term, fields) {
  return {
    minimum_should_match: 1,
    should: [
      {
        multi_match: {
          query: term,
          operator: "AND",
          fields: fields,
          boost: 2,
        },
      },
      {
        multi_match: {
          query: term,
          operator: "AND",
          fuzziness: 1,
          prefix_length: 2,
          fields: fields,
        },
      },
    ],
  };
}


function buildQuery(type, field, value) {
  const query = {};
  const filter = {};
  filter[field] = value; 
  query[type] = filter; 
  return query;
}

async function doTypedSearch(params, index, options) {
  const emptyParams = Object.keys(params).length === 0;
  const mainBody = emptyParams ? getRandomQuery() : getSearchBody(params, index, options);
  const body = Object.assign(mainBody, options);
  
  const results = await client.search({
    index,
    body,
  });

  return getFormattedResultsObject(results);
}

function getSearchBody(params, index, options) {
  switch (index) {
    case "artist":
      return buildArtistSearch(params, options);
    case "album":
      return buildAlbumSearch(params, options);
    case "track":
      return buildTrackSearch(params, options);
    case "document":
      return buildDocumentSearch(params, options);
    default:
      throw new Error("Invalid index for typed search");
  }
}

function getFormattedResultsObject(results) {  
  const formatted = {
    hits: [],
    count: 0,
  };

  if(results) {
    formatted.hits = results.hits.hits;
    formatted.count = results.hits.total.value;
  }

  return formatted;
}

async function bulk(body) {
  return await client.bulk({ refresh: true, body });
}

async function count(index) {
  return await client.count({ index });
}

function getAlbumId(album) {
  return album.album_id.value;
}

function getArtistId(artist) {
  return artist.id.toString();
}

function getDocumentId(document, subjectId) {
  return `${document.id}-${subjectId}`;
}

function getTrackId(track, album) {
  return `${getAlbumId(album)}-${track.track_num}`;
}


async function update(index, id, doc) {
  await client.update({
    id: id,
    index: index,
    body: {
      doc: doc,
      doc_as_upsert: true,
    },
  });
}

module.exports = {
  bulk,
  count,
  getAlbumId,
  getArtistId,
  getDocumentId,
  getTrackId,
  search,
  update,
};
