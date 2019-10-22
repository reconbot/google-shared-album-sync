// tslint:disable: no-console
/// <reference lib="esnext.asynciterable" />

import { google } from 'googleapis'
import { default as readline } from 'readline-promise'
import { readFile, writeFile, createWriteStream, exists, rename } from 'fs'
import { default as fetch } from 'node-fetch'
import { mkdirp } from 'mkdirp'
import { promisify } from 'util'
import { join } from 'path'
import { parallelMap, consume, buffer, writeToStream, pipeline, flatMap } from 'streaming-iterables'
import { OAuth2Client } from 'google-auth-library'

const readFileAsync = promisify(readFile)
const writeFileAsync = promisify(writeFile)
const mkdirpAsync = path => new Promise((resolve, reject) => mkdirp(path, err => (err ? reject(err) : resolve())))
const existsAsync = promisify(exists)
const renameAsync = promisify(rename)

const clientCredsPath = './clientCreds.json'
const REDIRECT = 'http://localhost'
const credCachePath = './auth.json'
const PHOTO_SEARCH_URL = 'https://photoslibrary.googleapis.com/v1/mediaItems:search'

async function authClient(rlp) {
  const { CLIENT_ID, CLIENT_SECRET } = await JSON.parse(await readFileAsync(clientCredsPath, { encoding: 'utf8'}))
  const oAuthClient = new google.auth.OAuth2({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT,
  })

  oAuthClient.on('tokens', tokens => {
    console.log('writing new tokens to disk', JSON.stringify(tokens, null, 2))
    writeFileAsync(credCachePath, JSON.stringify(tokens, null, 2)).then(() => console.log('done writing tokens'))
  })

  const creds: string | null = await readFileAsync(credCachePath, { encoding: 'utf8' }).catch(i => null)
  if (creds) {
    console.log('Using cached creds')
    oAuthClient.setCredentials(JSON.parse(creds))
    return oAuthClient
  }
  const url = oAuthClient.generateAuthUrl({
    access_type: 'offline',
    scope: 'https://www.googleapis.com/auth/photoslibrary.readonly',
    prompt: 'consent',
  })
  console.log(`Authorize this app by visiting this url: ${url}`)
  const code = await rlp.questionAsync('Enter the code in the address bar without the "#"(?code=<code>#) ')
  const { tokens } = await oAuthClient.getToken(code)
  await writeFileAsync(credCachePath, JSON.stringify(tokens, null, 2))
  oAuthClient.setCredentials(tokens)
  return oAuthClient
}

interface MediaItem {
  id: string
  baseUrl: string
  mediaMetadata: {
    photo: boolean
    video: boolean
    creationTime?: string
    width: number
    height: number
  }
}

type SearchResponse =
  | {
      error: { status: string; message: string }
      nextPageToken: undefined
      mediaItems: undefined
    }
  | {
      error: undefined
      nextPageToken?: string
      mediaItems: MediaItem[]
    }

async function* fetchPhotos(
  albumId: string,
  oAuthClient: OAuth2Client,
  pageToken?: string
): AsyncIterable<MediaItem[]> {
  console.log('getting request metadata')
  const authHeaders = await oAuthClient.getRequestHeaders()
  console.log('Fetching photos')
  const response = await fetch(PHOTO_SEARCH_URL, {
    headers: {
      ...authHeaders,
      'content-type': 'application/json',
    },
    method: 'POST',
    body: JSON.stringify({
      albumId,
      pageSize: 100,
      ...(pageToken && { pageToken }), // trick to only add this if it's truthy
    }),
  })

  const { mediaItems, nextPageToken, error } = (await response.json()) as SearchResponse
  if (error) {
    throw new Error(`${error.status}:${error.message}`)
  }
  if (!mediaItems) {
    throw new Error("This error exists because I don't know enough typescript")
  }
  console.log(`${mediaItems.length} Photos fetched`)
  yield mediaItems

  // cheap blows the stack way but I love it
  if (nextPageToken) {
    yield* fetchPhotos(albumId, oAuthClient, nextPageToken)
  }
}

const parseMediaItems = function*(mediaItems: MediaItem[]) {
  for (const item of mediaItems) {
    const { id, baseUrl, mediaMetadata } = item
    const idSlice = (id as string).slice(-4)
    const createdAtSafe = (mediaMetadata.creationTime || 'unknown').replace(/:/g, '_')
    const fileName = `${createdAtSafe}-${idSlice}`
    const { width, height } = mediaMetadata
    if (mediaMetadata.photo) {
      yield {
        fileName: `${fileName}.jpg`,
        url: `${baseUrl}=w${width}-h${height}`,
      }
    } else if (mediaMetadata.video) {
      yield {
        fileName: `${fileName}.mp4`,
        url: `${baseUrl}=dv`,
      }
    } else {
      console.log(item)
      throw new Error('unknown media type!')
    }
  }
}

const saveMedia = (folder: string) => async (media: { fileName: string; url: string }) => {
  const start = Date.now()
  if (!media) {
    return 'what happened!' + JSON.stringify({ media })
  }
  const { url, fileName } = media
  const path = join(folder, fileName)

  if (await existsAsync(path)) {
    console.log(`File already Exists ${fileName}`)
    return fileName
  }
  const tmpPath = join(folder, `${fileName}-downloading`)

  const request = await fetch(url, { method: 'GET' })
  const file = createWriteStream(tmpPath)
  await writeToStream(file, request.body)
  file.close()
  await new Promise(resolve => file.once('close', resolve))
  await renameAsync(tmpPath, path)
  console.log(`Downloaded ${fileName} in ${Date.now() - start}ms`)
  return fileName
}

async function main() {
  const rlp = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  const albumId = process.argv[2] || (await rlp.questionAsync('albumId? '))
  const folderName = process.argv[3] || (await rlp.questionAsync('folder name? [./photos] ')) || './photos'
  const oAuthClient = await authClient(rlp)
  rlp.close()

  await mkdirpAsync(folderName)
  await pipeline(
    () => fetchPhotos(albumId, oAuthClient),
    buffer(2),
    flatMap(parseMediaItems),
    parallelMap(10, saveMedia(folderName)),
    consume
  )
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err.stack)
    process.exit(1)
  }
)
