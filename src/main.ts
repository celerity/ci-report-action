import fs from 'fs'
import zlib from 'zlib'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as artifact from '@actions/artifact'

const artifactClient = artifact.create()

async function run() {
  try {
    const ghToken = core.getInput('gh-token')
    const octocat = new github.GitHub(ghToken)

    let comment = ''

    // Check build logs for warnings

    const builds = core
      .getInput('builds')
      .split(',')
      .map(b => b.trim())
    const buildWarnings = new Map<string, number>()
    for (const buildName of builds) {
      const response = await artifactClient.downloadArtifact(
        `build-${buildName}-log`,
        '.'
      )
      // For some reason what we get is still gzipped
      const compressedLog = fs.readFileSync(
        `${response.downloadPath}/build-${buildName}.log`
      )
      const log = zlib.gunzipSync(compressedLog).toString('utf8')
      // We try to closely match Clang's warning output format (including line and column) to avoid false positives
      const warningCount = (log.match(/^.*:\d+:\d+: warning:.*$/gm) || [])
        .length
      if (warningCount > 0) {
        buildWarnings.set(buildName, warningCount)
      }
    }

    if (buildWarnings.size > 0) {
      comment += '⚠️ Warnings were generated for the following builds:\n'
      buildWarnings.forEach((warningCount, buildName) => {
        comment += `- ${buildName}: ${warningCount}\n`
      })
    }

    // Report unformatted files

    const unformattedFiles = core
      .getInput('unformatted-files')
      .split('\n')
      .map(f => f.trim())
      .filter(f => f !== '')
    if (unformattedFiles.length !== 0) {
      if (comment !== '') comment += '\n\n'
      comment +=
        '⚠️ The following files are not formatted according to `.clang-format`:\n' +
        unformattedFiles.map(f => `- ${f}`).join('\n')
      for (const f of unformattedFiles) {
        // TODO: Is there a JS API for this?
        console.log(
          `::warning file=${f}:: File is not formatted according to \`.clang-format\``
        )
      }
    }

    if (comment !== '') {
      octocat.issues.createComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        issue_number: github.context.issue.number,
        body: comment
      })
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
