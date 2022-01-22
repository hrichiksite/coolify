import { asyncExecShell, createDirectories, getEngine, getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import type { RequestHandler } from '@sveltejs/kit';
import { letsEncrypt } from '$lib/letsencrypt';
import { configureSimpleServiceProxyOn } from '$lib/haproxy';
import { getDomain } from '$lib/components/common';

export const post: RequestHandler<Locals, FormData> = async (request) => {
    const { teamId, status, body } = await getUserDetails(request);
    if (status === 401) return { status, body }

    const { id } = request.params

    try {
        const service = await db.getService({ id, teamId })
        const { type, version, fqdn, destinationDockerId, destinationDocker, vscodeserver: { password } } = service

        const domain = getDomain(fqdn)
        const isHttps = fqdn.startsWith('https://')

        const network = destinationDockerId && destinationDocker.network
        const host = getEngine(destinationDocker.engine)

        const { workdir } = await createDirectories({ repository: type, buildId: id })
        const config = {
            image: `codercom/code-server:${version}`,
            volume: `${id}-vscodeserver-data:/home/coder`,
            environmentVariables: {
                PASSWORD: password
            },
        }
        const composeFile = {
            version: '3.8',
            services: {
                [id]: {
                    container_name: id,
                    image: config.image,
                    environment: config.environmentVariables,
                    networks: [network],
                    volumes: [config.volume],
                    restart: 'always',
                },
            },
            networks: {
                [network]: {
                    external: true
                }
            },
            volumes: {
                [config.volume.split(':')[0]]: {
                    external: true
                },
            },

        };
        const composeFileDestination = `${workdir}/docker-compose.yaml`
        await fs.writeFile(composeFileDestination, yaml.dump(composeFile))

        try {
            await asyncExecShell(`DOCKER_HOST=${host} docker volume create ${config.volume.split(':')[0]}`)
        } catch (error) {
            console.log(error)
        }

        try {
            await asyncExecShell(`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} up -d`)
            await configureSimpleServiceProxyOn({ id, domain, port: 8080 })

            if (isHttps) {
                await letsEncrypt({ domain, id })
            }
            return {
                status: 200
            }
        } catch (error) {
            console.log(error)
            return {
                status: 500,
                body: {
                    message: error
                }
            }
        }

    } catch (err) {
        return err
    }

}