import fs from 'fs'
import * as core from '@actions/core'
import * as github from '@actions/github'
import {DefaultArtifactClient} from '@actions/artifact'

const artifactClient = new DefaultArtifactClient()

interface BuildWarning {
  path: string
  line: number
  column: number
  message: string
}

// This is what Octokit expects; we should use their type but
// its buried somewhere deep inside auto-generated type definition files...
interface Annotation {
  path: string
  start_line: number
  end_line: number
  start_column?: number
  end_column?: number
  annotation_level: 'notice' | 'warning' | 'failure'
  message: string
}

async function getBuildWarnings() {
  // We download all artifacts under the assumption that they only contain build logs.
  // TODO: Decide which artifacts to download (based on name?) once https://github.com/actions/toolkit/issues/379 is fixed.
  const metaData = await artifactClient.listArtifacts()
  const allArtifacts = await Promise.all(
    metaData.artifacts.map(async meta => {
      console.log(`Downloading artifact ${meta.id} "${meta.name}"`)
      const {downloadPath} = await artifactClient.downloadArtifact(meta.id)
      return {
        artifactName: meta.name,
        downloadPath
      }
    })
  )

  const buildWarnings = new Map<string, Array<BuildWarning>>()

  for (const {artifactName: buildName, downloadPath} of allArtifacts) {
    const log = fs.readFileSync(`${downloadPath}/${buildName}.log`, {
      encoding: 'utf8'
    })

    const warnings = log
      .split('\n')
      // We try to closely match Clang's warning output format (including line and column) to avoid false positives
      .map(line => line.match(/(^.*):(\d+):(\d+): warning:(.*)$/))
      .filter(m => m !== null)
      .map((m: any /* TS thinks this can be null */) => ({
        // Paths are relative to build folder, which we assume to be within the main working directory.
        // We need to remove "../" for GitHub to correctly show these annotations within files.
        path: m[1].substr(3),
        line: Number.parseInt(m[2]),
        column: Number.parseInt(m[3]),
        message: m[4]
      }))

    if (warnings.length > 0) {
      buildWarnings.set(buildName, warnings)
    }
  }

  const numBuilds = allArtifacts.length
  return {buildWarnings, numBuilds}
}

function getUnformattedFiles() {
  return core
    .getInput('unformatted-files')
    .split('\n')
    .map(f => f.trim())
    .filter(f => f !== '')
}

// We are limited to 50 annotations in a single API request
const MAX_ANNOTATIONS = 50

/**
 * Checks for unformatted files and build warnings and reports results.
 *
 * Results are reported through the GitHub Checks API.
 */
async function run() {
  try {
    const ghToken = core.getInput('gh-token')
    const octocat = github.getOctokit(ghToken)

    const {buildWarnings, numBuilds} = await getBuildWarnings()
    if (numBuilds === 0) {
      core.setFailed('No build logs found')
      return
    }
    const unformattedFiles = getUnformattedFiles()

    const annotations: Array<Annotation> = []
    const summarySections: Array<string> = []
    const textSections: Array<string> = []

    // Reserve space for unformatted file annotations
    const maxWarningAnnotations = Math.max(
      0,
      MAX_ANNOTATIONS - unformattedFiles.length
    )

    if (buildWarnings.size > 0) {
      let totalWarningCount = 0
      let warningAnnotationsCreated = 0
      buildWarnings.forEach((warnings, buildName) => {
        totalWarningCount += warnings.length
        for (const w of warnings) {
          if (++warningAnnotationsCreated >= maxWarningAnnotations) break
          annotations.push({
            path: w.path,
            start_line: w.line,
            end_line: w.line,
            start_column: w.column,
            end_column: w.column,
            annotation_level: 'warning',
            message: `Build "${buildName}" generated warning: ${w.message}`
          })
        }
      })

      summarySections.push(
        `Warnings were generated for ${buildWarnings.size} of ${numBuilds} build(s).`
      )
      let text = '⚠️ Warnings were generated for the following build(s):\n'
      buildWarnings.forEach((warnings, buildName) => {
        text += `- ${buildName}: ${warnings.length}\n`
      })
      if (totalWarningCount >= maxWarningAnnotations) {
        text += `\n\nShowing first **${maxWarningAnnotations}** warnings out of **${totalWarningCount}** total.`
      }
      textSections.push(text)
    } else {
      summarySections.push('No warnings were generated.')
    }

    if (unformattedFiles.length > 0) {
      for (const f of unformattedFiles) {
        annotations.push({
          path: f,
          start_line: 1,
          end_line: 1,
          annotation_level: 'failure',
          message: 'File is not formatted according to `.clang-format`.'
        })
      }

      summarySections.push(
        'Some files are not formatted according to `.clang-format`.'
      )
      textSections.push(
        '️❌ The following files are not formatted according to `.clang-format`:\n' +
          unformattedFiles.map(f => `- ${f}`).join('\n')
      )
    } else {
      summarySections.push(
        'All files are formatted according to `.clang-format`.'
      )
    }

    const {eventName} = github.context
    const trigger =
      eventName === 'pull_request' || eventName === 'pull_request_target'
        ? 'pr'
        : eventName

    let headSha = github.context.sha
    // For PRs we have to find the correct SHA to attach the check to.
    // (There might be an easier way of doing this, but I couldn't find it.)
    if (trigger === 'pr') {
      const {data: pullRequest, status} = await octocat.rest.pulls.get({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request?.number!
      })
      if (status !== 200) {
        core.setFailed(`Failed to get pull request: ${status}`)
        return
      }
      headSha = pullRequest.head.sha
    }

    const response = await octocat.rest.checks.create({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      head_sha: headSha,
      // Use different name for Check depending on how this was triggered.
      name: `celerity-ci-report-${trigger}`,
      completed_at: new Date().toISOString(),
      // There is no "warning" conclusion, so we set it to "action_required" if there a build warnings.
      conclusion:
        unformattedFiles.length > 0
          ? 'failure'
          : buildWarnings.size > 0
            ? 'action_required'
            : 'success',
      output: {
        title: 'Celerity CI Report',
        summary: summarySections.join(' '),
        text: textSections.join('\n\n'),
        annotations
      }
    })

    if (response.status !== 201) {
      core.setFailed(`Failed to create check: ${response}`)
      return
    }

    // Creating a failed check for some reason doesn't fail the CI run,
    // so we additionally have to fail this action.
    if (unformattedFiles.length > 0) {
      core.setFailed(summarySections[1])
    }
  } catch (error: any) {
    core.setFailed(error.message ?? 'Unknown error')
  }
}

run()
