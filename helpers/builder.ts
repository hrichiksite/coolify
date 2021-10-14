
import Build from 'App/Models/Build'
import crypto from 'crypto'
import * as buildpacks from './buildPacks'
import * as importers from './importers'
import { dockerInstance } from './docker'
import { asyncExecShell, saveBuildLog } from './common'
import Application from 'App/Models/Application'
import got from 'got'

export default async function (job) {
  /*
    Edge cases:
    1 - Change build pack and redeploy, what should happen?
  */
  let { id, repository, branch, build_pack: buildPack, destinationDocker, gitSource, build_id: buildId, config_hash: configHash, port, install_command: installCommand, build_command: buildCommand, start_command: startCommand, domain, old_domain: oldDomain } = job.data

  const destinationSwarm = null
  const kubernetes = null

  let deployNeeded = true

  const docker = dockerInstance({ destinationDocker })

  const build = await Build.create({
    id: buildId,
    applicationId: id,
    destinationDockerId: destinationDocker.id,
    gitSourceId: gitSource.id,
    githubAppId: gitSource.githubApp.id,
    status: 'running',
  })
  const workdir = `/tmp/build-sources/${repository}/${build.id}`
  await asyncExecShell(`mkdir -p ${workdir}`)

  // TODO: Separate logic
  console.log(domain, oldDomain)
  if (buildPack === 'node') {
    if (!port) port = 3000
    if (!installCommand) installCommand = 'yarn install'
    if (!startCommand) startCommand = 'yarn start'
  }
  const commit = await importers[gitSource.type]({ workdir, githubAppId: gitSource.githubApp.id, repository, branch, buildId: build.id })
  await build.merge({ commit }).save()

  const currentHash = crypto.createHash('sha256').update(JSON.stringify({ buildPack, port, installCommand, buildCommand, startCommand })).digest('hex')
  if (configHash !== currentHash) {
    const applicationFound = await Application.findOrFail(id)
    await applicationFound.merge({ configHash: currentHash }).save()
    deployNeeded = true
    saveBuildLog({ line: 'Configuration changed, redeploying.', buildId })
  } else {
    deployNeeded = false
  }

  const image = await docker.engine.getImage(`${id}:${commit.slice(0, 7)}`)

  let imageFound = false
  try {
    await image.inspect()
    imageFound = true
  } catch (error) {
    //
  }
  if (!imageFound || deployNeeded) {
    await buildpacks[buildPack]({ id, commit, workdir, docker, buildId: build.id, port, installCommand, buildCommand, startCommand })
  } else {
    deployNeeded = false
    saveBuildLog({ line: 'Nothing changed.', buildId })
  }

  // TODO: Separate logic
  if (deployNeeded) {
    if (destinationDocker) {
      // Deploy to docker
      try {
        await asyncExecShell(`docker stop -t 0 ${id}`)
        await asyncExecShell(`docker rm ${id}`)
      } catch (error) {
        //
      } finally {
        saveBuildLog({ line: 'Remove old deployments.', buildId })
      }

      // TODO: Must be localhost
      if (destinationDocker.engine === '/var/run/docker.sock') {
        saveBuildLog({ line: 'Deploying.', buildId })
        const { stderr } = await asyncExecShell(`docker run --name ${id} --network ${docker.network} --restart always -d ${id}:${commit.slice(0, 7)}`)
        if (stderr) console.log(stderr)
        saveBuildLog({ line: 'Deployment successful!', buildId })
      }
      // TODO: Implement remote docker engine

    } else if (destinationSwarm) {
      // Deploy to swarm
    } else if (kubernetes) {
      // Deploy to k8s
    }
  }
  // TODO: Separate logic
  const haproxy = got.extend({
    prefixUrl: 'http://coolify-haproxy:5555',
    username: 'haproxy-dataplaneapi',
    password: 'adminpwd'
  });

  try {
    let version = 1
    const raw = await haproxy.get(`v2/services/haproxy/configuration/raw`).json()
    if (raw?._version) version = raw._version

    const newTransaction: any = await haproxy.post('v2/services/haproxy/transactions', {
      searchParams: {
        version
      }
    }).json()

    try {
      const backendFound = await haproxy.get(`v2/services/haproxy/configuration/backends/${domain}`).json()
      if (backendFound) {
        await haproxy.delete(`v2/services/haproxy/configuration/backends/${domain}`, {
          searchParams: {
            transaction_id: newTransaction.id
          },
        }).json()
        saveBuildLog({ line: 'HAPROXY - Old backend deleted.', buildId })
      }

    } catch (error) {
      // Backend not found, no worries, it means it's not defined yet
    }
    try {
      console.log(oldDomain)
      if (oldDomain) {
        await haproxy.delete(`v2/services/haproxy/configuration/backends/${oldDomain}`, {
          searchParams: {
            transaction_id: newTransaction.id
          },
        }).json()
        const applicationFound = await Application.findOrFail(id)
        await applicationFound.merge({ oldDomain: '' }).save()
        saveBuildLog({ line: 'HAPROXY - Old backend deleted with different domain.', buildId })
      }
    } catch (error) {
      // Backend not found, no worries, it means it's not defined yet
    }
    await haproxy.post('v2/services/haproxy/configuration/backends', {
      searchParams: {
        transaction_id: newTransaction.id
      },
      json: {
        "forwardfor": { "enabled": "enabled" },
        "name": domain
      }
    })

    saveBuildLog({ line: 'HAPROXY - New backend defined.', buildId })
    await haproxy.post('v2/services/haproxy/configuration/servers', {
      searchParams: {
        transaction_id: newTransaction.id,
        backend: domain
      },
      json: {
        "address": id,
        "check": "enabled",
        "name": id,
        "port": port
      }
    })
    saveBuildLog({ line: 'HAPROXY - New servers defined.', buildId })

    await haproxy.put(`v2/services/haproxy/transactions/${newTransaction.id}`)
    saveBuildLog({ line: 'HAPROXY - Transaction done.', buildId })
  } catch (error) {
    console.log(error)
  }
  // Set SSL with Let's encrypt
  if (destinationDocker) {
    // Deploy to docker
    // TODO: Must be localhost
    if (destinationDocker.engine === '/var/run/docker.sock') {
      // TODO: Must wait if there is a certbot container already running
      saveBuildLog({ line: 'Requesting SSL cert.', buildId })
      const { stderr } = await asyncExecShell(`docker run -it --rm --name certbot -p 9080:9080 -v "/usr/local/etc/haproxy/:/usr/local/etc/haproxy/" certbot/certbot --work-dir /usr/local/etc/haproxy/ssl certonly --standalone --preferred-challenges http --http-01-address 0.0.0.0 --http-01-port 9080 -d ${domain} --agree-tos --non-interactive --register-unsafely-without-email`)
      if (stderr) console.log(stderr)
      saveBuildLog({ line: 'SSL cert requested successfully!', buildId })
    }
    // TODO: Implement remote docker engine

  } else if (destinationSwarm) {
    // Deploy to swarm
  } else if (kubernetes) {
    // Deploy to k8s
  }


  await asyncExecShell(`rm -fr ${workdir}`)
}