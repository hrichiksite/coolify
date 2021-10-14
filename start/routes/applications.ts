import Route from '@ioc:Adonis/Core/Route'
import Application from 'App/Models/Application'
import DestinationDocker from 'App/Models/DestinationDocker'
import GitSource from 'App/Models/GitSource'
import jsonwebtoken from 'jsonwebtoken'
import Database from '@ioc:Adonis/Lucid/Database'
import cuid from 'cuid'
import crypto from 'crypto'

import { buildQueue } from 'Helpers/queue'
import Build from 'App/Models/Build'

const buildPacks = ['node', 'static']

Route.get('/applications', async ({ view }) => {
  const applications = await Application.all()
  return view.render('pages/applications/index', { applications })
})

Route.post('/applications/new', async ({ request, response, view }) => {
  const appName = request.input('appName')
  const found = await Application.findBy('name', appName)
  if (found) {
    return view.render('pages/applications/new', { found: true })
  }
  await Application.create({
    name: appName,
  })
  return response.redirect(`/applications/${appName}`)
})

Route.get('/applications/:name', async ({ response, params, view }) => {
  if (params.name === 'new') return view.render('pages/applications/new')
  let applicationFound = await Application.findByOrFail('name', params.name)
  const builds = await Database.from('builds').select('*').where('application_id', applicationFound.id)
  if (applicationFound) {
    try {
      await applicationFound.load('gitSource')
      await applicationFound.load('destinationDocker')
    } catch (error) { }

    return view.render('pages/applications/name/index', {
      name: params.name,
      application: applicationFound,
      buildPacks,
      builds
    })
  }
  return response.redirect('/dashboard')
})

Route.post('/applications/:name/deploy', async ({ params, response }) => {
  try {
    const buildId = cuid()
    const applicationFound = await Application.findByOrFail('name', params.name)
    await applicationFound.load('destinationDocker')
    await applicationFound.load('gitSource')
    await applicationFound.gitSource.load('githubApp')
    if (!applicationFound.configHash) {
      const configHash = crypto.createHash('sha256').update(JSON.stringify({ buildPack: applicationFound.buildPack, port: applicationFound.port, installCommand: applicationFound.installCommand, buildCommand: applicationFound.buildCommand, startCommand: applicationFound.startCommand })).digest('hex')
      await applicationFound.merge({ configHash }).save()
    }
    await buildQueue.add(buildId, { build_id: buildId, ...applicationFound.toJSON() })
    return response.redirect(`/applications/${params.name}/logs/${buildId}`)
  } catch (error) {
    return response.redirect(`/applications/${params.name}`)
  }
})

Route.get('/applications/:name/logs/:buildId', async ({ params, view }) => {
  let logs;
  try {
    logs = await Database.from('build_logs').where('build_id', params.buildId)
  } catch (error) {
    console.log(error)
  }
  const build = await Build.findOrFail(params.buildId)
  return view.render('pages/applications/name/logs/log', { name: params.name, logs, status: build.status })
})

Route.get('/applications/:name/source', async ({ params, view }) => {
  const applicationFound = await Application.findBy('name', params.name)
  const gitSources = await (await GitSource.all()).filter((source) => source.githubAppId)
  if (applicationFound) {
    try {
      await applicationFound.load('gitSource')
      await applicationFound.gitSource.load('githubApp')
    } catch (error) { }
    return view.render('pages/applications/name/source', {
      name: params.name,
      application: applicationFound,
      gitSources,
    })
  }
  return view.render('pages/applications/name/source', { name: params.name })
})

Route.post('/applications/:name/source', async ({ response, params, request }) => {
  const gitSourceId = request.input('gitSourceId')
  const applicationFound = await Application.findByOrFail('name', params.name)
  const gitSourceFound = await GitSource.findOrFail(gitSourceId)
  if (gitSourceFound && gitSourceFound.githubAppId && applicationFound) {
    if (applicationFound.gitSourceId !== gitSourceId) {
      applicationFound.repository = ''
      applicationFound.branch = ''
    }
    await gitSourceFound.related('applications').save(applicationFound)
  }
  return response.redirect(`/applications/${params.name}`)
})

Route.get('/applications/:name/repository', async ({ params, view, session }) => {
  const applicationFound = await Application.findBy('name', params.name)
  const gitSources = await GitSource.all()
  if (applicationFound) {
    try {
      await applicationFound.load('gitSource')
      await applicationFound.gitSource.load('githubApp')
    } catch (error) { }
    if (applicationFound.gitSource) {
      const payload = {
        iat: Math.round(new Date().getTime() / 1000),
        exp: Math.round(new Date().getTime() / 1000 + 60),
        iss: applicationFound.gitSource.githubApp.appId,
      }
      const jwtToken = jsonwebtoken.sign(payload, applicationFound.gitSource.githubApp.privateKey, {
        algorithm: 'RS256',
      })
      session.put('githubAppToken', jwtToken)

      return view.render('pages/applications/name/repository', {
        name: params.name,
        application: applicationFound,
        gitSources,
        githubAppToken: session.get('githubAppToken'),
      })
    } else {
      return view.render('pages/applications/name/repository', {
        name: params.name,
        application: applicationFound,
        gitSources,
      })
    }
  }
  return view.render('pages/applications/name/repository', { name: params.name })
})

Route.post('/applications/:name/repository', async ({ response, request, params }) => {
  const applicationFound = await Application.findByOrFail('name', params.name)
  const { repository, branch } = request.body()
  if (applicationFound && repository && branch) {
    await applicationFound.merge({ branch, repository }).save()
  }
  return response.redirect(`/applications/${params.name}`)
})

Route.get('/applications/:name/destination', async ({ params, view }) => {
  const dockers = await DestinationDocker.all()
  return view.render('pages/applications/name/destination', { name: params.name, dockers })
})

Route.post('/applications/:name/destination', async ({ request, params, response }) => {
  const { destination } = request.body()
  const applicationFound = await Application.findByOrFail('name', params.name)
  const destinationFound = await DestinationDocker.findOrFail(destination)
  if (applicationFound && destinationFound) {
    await destinationFound.related('applications').save(applicationFound)
  }
  return response.redirect(`/applications/${params.name}`)
})


Route.post('/applications/:name/configuration', async ({ request, params, response }) => {
  const { buildPack, port, installCommand, buildCommand, startCommand, domain } = request.body()
  const applicationFound = await Application.findByOrFail('name', params.name)
  if (applicationFound.domain !== domain) {
    await applicationFound.merge({ buildPack, port, installCommand, buildCommand, startCommand, domain, oldDomain: applicationFound.domain }).save()
  } else {
    await applicationFound.merge({ buildPack, port, installCommand, buildCommand, startCommand, domain }).save()
  }

  return response.redirect().back()
})