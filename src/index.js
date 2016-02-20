'use strict';

let semver = require('semver');
let _ = require('lodash');

class RecursiveSemver {
  constructor(name, version, dependencies, getVersions, getDependencies) {
    this.getVersions = getVersions;
    this.getDependencies = getDependencies;
    this.root = name;
    let state = this.state = {};
    let rootState = state[name] = {};
    rootState.version = version;
    rootState.dependencies = dependencies;
    this.queuedCalculations = Object.keys(dependencies);
    this.queuedConstraintUpdates = [];
    this.cachedVersions = {};
    this.cachedDependencies = {};
  }

  cleanQueuedCalculations() {
    let state = this.state;
    let knownLibraries = Object.keys(state);
    knownLibraries.forEach(library => {
      let dependencies = state[library].dependencies;
      if (dependencies) {
        knownLibraries = _.union(
          knownLibraries,
          Object.keys(dependencies)
        );
      }
    });
    this.queuedCalculations = _.intersection(
      this.queuedCalculations,
      knownLibraries
    );
  }

  dropLibrary(library) {
    let queuedCalculations = this.queuedCalculations;
    let state = this.state;
    let libraryState = state[library];
    if (libraryState) {
      // remove from state
      delete state[library];
      let dependencies = libraryState.dependencies;
      if (dependencies) {
        _.forEach(Object.keys(dependencies), dependency => {
          // drop old data for dependency as it should not
          // be used in calculations anymore
          this.dropLibrary(dependency);
          // queue dependency for recalculation
          // as a constraint has been dropped
          queuedCalculations.push(library);
        });
      }
    }
  }

  updateConstraints(library) {
    let state = this.state;
    let cachedDependencies = this.cachedDependencies;
    let libraryState = state[library];
    // check if this library is still in the state.
    // it may already have been dropped in an earlier
    // update, in which case the information we would
    // apply now is invalid anyway
    if (libraryState) {
      let version = libraryState.version;
      let newDependencies = cachedDependencies[library][version];
      let oldDependencies = libraryState.dependencies;
      let queuedCalculations = this.queuedCalculations;
      if (oldDependencies !== newDependencies) {
        let dependenciesToInvalidate = Object.keys(newDependencies);
        if (oldDependencies) {
          dependenciesToInvalidate = _.union(
            dependenciesToInvalidate,
            Object.keys(oldDependencies)
          );
        }
        dependenciesToInvalidate.forEach(dependency => {
          // drop old data for dependency as it should not
          // be used in calculations anymore
          this.dropLibrary(dependency);
          // queue dependency for recalculation
          // as a constraint has been dropped
          queuedCalculations.push(dependency);
        });
        libraryState.dependencies = newDependencies;
      }
    }
  }

  maxSatisfying(library) {
    let state = this.state;
    let versions = this.cachedVersions[library];
    let validVersion;
    let ranges = [];
    _.forOwn(state, libraryState => {
      let dependencies = libraryState.dependencies;
      if (dependencies) {
        let range = dependencies[library];
        if (range) {
          ranges.push(range);
        }
      }
    });
    _.forEach(versions, version => {
      let valid = true;
      _.forEach(ranges, range => {
        if (!semver.satisfies(version, range)) {
          valid = false;
          return false;
        }
      });
      if (valid) {
        validVersion = version;
        return false;
      }
    });
    if (validVersion) {
      return validVersion;
    }
    // TODO: figure out where the conflict is and see if an earlier version will
    // satisfy the constraints
    throw new Error(
      `Unable to satisfy version constraints: ${library}@${ranges}`
    );
  }

  cacheVersions() {
    let cachedVersions = this.cachedVersions;
    let librariesAlreadyCached = Object.keys(cachedVersions);
    let queuedCalculations = this.queuedCalculations;
    let librariesToCache = _.difference(
      queuedCalculations, librariesAlreadyCached
    );
    return Promise.all(librariesToCache.map(this.getVersions))
    .then(versionsArray => {
      versionsArray.forEach((versions, index) => {
        cachedVersions[librariesToCache[index]] =
          versions.slice(0).sort(semver.rcompare);
      });
    });
  }

  resolveVersions() {
    let queuedCalculations = this.queuedCalculations;
    this.queuedCalculations = [];
    let state = this.state;
    let queuedConstraintUpdates = this.queuedConstraintUpdates;
    queuedCalculations.forEach(library => {
      let version = this.maxSatisfying(library);
      state[library] = state[library] || {};
      state[library].version = version;
      queuedConstraintUpdates.push(library);
    });
  }

  cacheDependencies() {
    let state = this.state;
    let cachedDependencies = this.cachedDependencies;
    let queuedConstraintUpdates = this.queuedConstraintUpdates;
    let dependenciesToCache = queuedConstraintUpdates.filter(library => {
      let version = state[library].version;
      let versions = cachedDependencies[library];
      if (versions) {
        if (versions[version]) {
          return false;
        }
      }
      return true;
    });
    return Promise.all(dependenciesToCache.map(
      library => {
        return this.getDependencies(
          library,
          state[library].version
        );
      }
    ))
    .then(dependenciesArray => {
      dependenciesArray.forEach((dependencies, index) => {
        let library = dependenciesToCache[index];
        cachedDependencies[library] = cachedDependencies[library] || {};
        cachedDependencies[library][state[library].version] = dependencies;
      });
    });
  }

  refillQueues() {
    let queuedConstraintUpdates = _.uniq(this.queuedConstraintUpdates);
    this.queuedConstraintUpdates = [];
    queuedConstraintUpdates.forEach(library => {
      this.updateConstraints(library);
    });
    // clean up the queued calculations
    // as some of the libraries may no longer
    // even be in dependencies
    this.cleanQueuedCalculations();
  }

  recurse() {
    if (this.queuedCalculations.length) {
      return this.start();
    }
  }

  start() {
    return this.cacheVersions()
    .then(this.resolveVersions.bind(this))
    .then(this.cacheDependencies.bind(this))
    .then(this.refillQueues.bind(this))
    .then(this.recurse.bind(this));
  }

  resolve() {
    return this.start()
    .then(() => {
      let resolution = _.mapValues(this.state, value => value.version);
      delete resolution[this.root];
      return resolution;
    });
  }
}

module.exports = RecursiveSemver;
