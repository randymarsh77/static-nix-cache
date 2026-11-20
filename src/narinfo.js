'use strict';

/**
 * Give a field with no value the space Nix expects after its colon.
 *
 * Nix reads a narinfo line as "Name: value" and takes the value from two
 * characters past the colon. A line that is only "References:" sends it past
 * the end of the line, so it reads the next line as the value and fails with
 * "'Sig:' is too short to be a valid store path". A path with no references
 * and no deriver ends in exactly that line, and metadata published before
 * this was understood has it, so it is repaired wherever metadata is read.
 *
 * @param {string} content - narinfo text
 * @returns {string}
 */
function repairEmptyFields(content) {
  return content.replace(/^([A-Za-z]+):$/gm, '$1: ');
}

module.exports = { repairEmptyFields };
