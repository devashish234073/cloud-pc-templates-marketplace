'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Zero-dependency in-memory vector database with JSON persistence.
 * Brute-force search — O(n) per query. Fine up to a few hundred thousand
 * vectors on modest hardware; beyond that you'd want an approximate index
 * (HNSW/IVF), which is out of scope here (see README "Scaling" section).
 */
class VectorDB {
  /**
   * @param {Object} options
   * @param {number} [options.dimension] - Fixed vector dimension. Inferred from first insert if omitted.
   * @param {'cosine'|'euclidean'|'dot'} [options.metric] - Similarity/distance metric.
   * @param {string} [options.persistPath] - File path for save()/load(); auto-loads if it exists.
   */
  constructor(options = {}) {
    this.dimension = options.dimension || null;
    this.metric = options.metric || 'cosine';
    this.vectors = new Map();   // id -> Float32Array
    this.metadata = new Map();  // id -> object
    this.norms = new Map();     // id -> precomputed L2 norm (cosine only)
    this.persistPath = options.persistPath || null;

    if (this.persistPath && fs.existsSync(this.persistPath)) {
      this.load(this.persistPath);
    }
  }

  _toFloat32(vec) {
    return vec instanceof Float32Array ? vec : Float32Array.from(vec);
  }

  _norm(vec) {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    return Math.sqrt(sum);
  }

  _dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
  }

  /**
   * Insert or overwrite a vector.
   * @param {string} id
   * @param {number[]|Float32Array} vector
   * @param {Object} [metadata]
   */
  insert(id, vector, metadata = {}) {
    const vec = this._toFloat32(vector);
    if (this.dimension === null) this.dimension = vec.length;
    if (vec.length !== this.dimension) {
      throw new Error(`Dimension mismatch: expected ${this.dimension}, got ${vec.length}`);
    }
    this.vectors.set(id, vec);
    this.metadata.set(id, metadata);
    this.norms.set(id, this._norm(vec));
    return { id, dimension: vec.length };
  }

  insertBatch(items) {
    return items.map(({ id, vector, metadata }) => this.insert(id, vector, metadata));
  }

  delete(id) {
    const existed = this.vectors.has(id);
    this.vectors.delete(id);
    this.metadata.delete(id);
    this.norms.delete(id);
    return existed;
  }

  get(id) {
    if (!this.vectors.has(id)) return null;
    return {
      id,
      vector: Array.from(this.vectors.get(id)),
      metadata: this.metadata.get(id)
    };
  }

  size() {
    return this.vectors.size;
  }

  _score(queryVec, queryNorm, id) {
    const vec = this.vectors.get(id);
    switch (this.metric) {
      case 'dot':
        return this._dot(queryVec, vec);
      case 'euclidean': {
        let sum = 0;
        for (let i = 0; i < vec.length; i++) {
          const d = queryVec[i] - vec[i];
          sum += d * d;
        }
        return -Math.sqrt(sum); // negate so "higher = closer" holds for all metrics internally
      }
      case 'cosine':
      default: {
        const denom = queryNorm * this.norms.get(id);
        if (denom === 0) return 0;
        return this._dot(queryVec, vec) / denom;
      }
    }
  }

  /**
   * @param {number[]|Float32Array} queryVector
   * @param {Object} [options]
   * @param {number} [options.topK=10]
   * @param {(metadata: Object) => boolean} [options.filter] - Optional metadata predicate applied before scoring.
   */
  search(queryVector, options = {}) {
    const topK = options.topK || 10;
    const filter = options.filter || null;
    const queryVec = this._toFloat32(queryVector);

    if (this.dimension !== null && queryVec.length !== this.dimension) {
      throw new Error(`Dimension mismatch: expected ${this.dimension}, got ${queryVec.length}`);
    }

    const queryNorm = this.metric === 'cosine' ? this._norm(queryVec) : 0;
    const results = [];

    for (const id of this.vectors.keys()) {
      if (filter && !filter(this.metadata.get(id))) continue;
      results.push({ id, score: this._score(queryVec, queryNorm, id) });
    }

    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK).map(r => ({
      id: r.id,
      score: this.metric === 'euclidean' ? -r.score : r.score, // report true (positive) distance
      metadata: this.metadata.get(r.id)
    }));
  }

  save(filepath = this.persistPath) {
    if (!filepath) throw new Error('No persist path specified');
    const data = {
      dimension: this.dimension,
      metric: this.metric,
      entries: Array.from(this.vectors.keys()).map(id => ({
        id,
        vector: Array.from(this.vectors.get(id)),
        metadata: this.metadata.get(id)
      }))
    };
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify(data));
    return { path: filepath, count: data.entries.length };
  }

  load(filepath = this.persistPath) {
    if (!filepath || !fs.existsSync(filepath)) return { loaded: 0 };
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    this.dimension = data.dimension;
    this.metric = data.metric || this.metric;
    this.vectors.clear();
    this.metadata.clear();
    this.norms.clear();
    for (const entry of data.entries) {
      this.insert(entry.id, entry.vector, entry.metadata);
    }
    return { loaded: data.entries.length };
  }
}

module.exports = VectorDB;