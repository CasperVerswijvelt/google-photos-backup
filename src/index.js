import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import path from 'path'
import { moveFile } from 'move-file'
import fsP from 'node:fs/promises'
import { ExifDateTime, exiftool } from 'exiftool-vendored'
import { program } from "commander"
import { mkdir } from 'fs/promises'

chromium.use(stealth())

// accept --headless=false argument to run in headful mode
if (process.argv[2] === '--headless=false') {
  headless = false
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const getProgress = async (downloadPath) => {
  const lastDone = await fsP.readFile(path.join(downloadPath, '.lastdone'), 'utf-8')
  if (lastDone === '') throw new Error("empty file")
  return lastDone
}

const saveProgress = async (directory, url) => {
  await mkdir(directory, { recursive: true })
  await fsP.writeFile(path.join(directory, '.lastdone'), url, 'utf-8')
}

const start = async (
  {
    headless,
    photoDirectory,
    sessionDirectory,
    initialPhotoUrl,
    writeScrapedExif,
    flatDirectoryStructure
  }
) => {
  let startLink
  try {
    startLink = await getProgress(photoDirectory)
  } catch (e) {
    console.log("Empty or non-existing .lastdone file")
    if (initialPhotoUrl) {
      console.log(`Populating from --initial-photo-url parameter: ${initialPhotoUrl}`)
      await saveProgress(photoDirectory, initialPhotoUrl)
      startLink = initialPhotoUrl
    } else {
      console.log('Please pass initial photo url using the --initial-photo-url parameter or manually populate the .lastdone file in your photo directory')
      return process.exit(1)
    }
  }
  console.log('Starting from:', new URL(startLink).href)

  const browser = await chromium.launchPersistentContext(path.resolve(sessionDirectory), {
    headless,
    acceptDownloads: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  const cleanup = async () => {
    await browser.close()
    await exiftool.end()
  }

  const page = await browser.newPage()

  const mainGooglePhotosUrl = "https://photos.google.com/"

  await page.goto(mainGooglePhotosUrl)

  const pageUrl = page.url()

  if (pageUrl !== mainGooglePhotosUrl) {
    console.log(`Page was redirected to ${pageUrl}, please authenticate first using the 'setup' command`)
    await cleanup()
    return process.exit(1)
  }

  const latestPhoto = await getLatestPhoto(page)
  if (!latestPhoto) {
    console.log('Could not determine latest photo')
    await cleanup()
    return process.exit(1)
  }
  console.log('Latest Photo:', latestPhoto)
  console.log('-------------------------------------')

  await page.goto(clean(startLink))

  /*
    We download the first (Oldest) photo and overwrite it if it already exists. Otherwise running first time, it will skip the first photo.
  */
  await downloadPhoto(
    page,
    {
      photoDirectory,
      overwrite: true,
      writeScrapedExif,
      flatDirectoryStructure
    }
  )

  while (true) {
    const currentUrl = page.url()

    if (clean(currentUrl) === clean(latestPhoto)) {
      console.log('-------------------------------------')
      console.log('Reached the latest photo, exiting...')
      break
    }

    /*
      We click on the left side of arrow in the html. This will take us to the previous photo.
      Note: I have tried both left arrow press and clicking directly the left side of arrow using playwright click method.
      However, both of them are not working. So, I have injected the click method in the html.
    */
    await page.evaluate(() => document.getElementsByClassName('SxgK2b OQEhnd')[0].click())

    // we wait until new photo is loaded
    await page.waitForURL((url) => {
      return url.host === 'photos.google.com' && url.href !== currentUrl
    })

    await downloadPhoto(
      page,
      {
        photoDirectory: photoDirectory,
        writeScrapedExif: writeScrapedExif
      }
    )
    await saveProgress(photoDirectory, page.url())
  }
  await cleanup()
}

const setup = async (sessionDirectory) => {
  const browser = await chromium.launchPersistentContext(path.resolve(sessionDirectory), {
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })
  const page = await browser.newPage()
  await page.goto('https://photos.google.com/')

  console.log('Close browser once you are logged inside Google Photos')
}

const downloadPhoto = async (page, {
  photoDirectory,
  overwrite = false,
  writeScrapedExif = false,
  flatDirectoryStructure = false
}) => {
  const downloadPromise = page.waitForEvent('download')

  await page.keyboard.down('Shift')
  await page.keyboard.press('KeyD')

  const download = await downloadPromise
  const temp = await download.path()
  const fileName = await download.suggestedFilename()

  const metadata = await exiftool.read(temp)

  let year = metadata.DateTimeOriginal?.year || 1970
  let month = metadata.DateTimeOriginal?.month || 1

  if (year === 1970 && month === 1) {
    // if metadata is not available, we try to get the date from the html
    console.log('Metadata not found, trying to get date from html')
    const data = await page.request.get(page.url())
    const html = await data.text()

    // RegEx only works for English
    const regex = /aria-label="(?:Photo|Video) ((?:[–-]) ([^"–-]+))+"/
    const match = regex.exec(html)

    if (match) {
      const lastMatch = match.pop()
      console.log(`Metadata in HTML: ${lastMatch}`)
      const date = new Date(lastMatch)
      year = date.getFullYear()
      month = date.getMonth() + 1

      if (writeScrapedExif) {
        console.log("Saving scraped datetime to exif metadata")
        await exiftool.write(temp, { DateTimeOriginal: ExifDateTime.fromMillis(date.getTime()) })
      }
    } else {
      console.log('Could not find metadata in HTML, was language set to english?')
    }
  }

  const destDir = flatDirectoryStructure
    ? path.join(photoDirectory, fileName)
    : path.join(photoDirectory, `${year}`, `${month}`, fileName)

  try {
    await moveFile(temp, destDir, { overwrite })
    console.log('Download Complete:', destDir)
  } catch (error) {
    const randomNumber = Math.floor(Math.random() * 1000000)
    const fileName = await download.suggestedFilename().replace(/(\.[\w\d_-]+)$/i, `_${randomNumber}$1`)
    await moveFile(temp, `${photoDirectory}/${year}/${month}/${fileName}`)
    console.log('Download Complete:', `${year}/${month}/${fileName}`)
  }
}

/*
  This function is used to get the latest photo in the library. Once Page is loaded,
  We press right click, It will select the latest photo in the grid. And then
  we get the active element, which is the latest photo.
*/
const getLatestPhoto = async (page) => {
  await sleep(2000)
  await page.keyboard.press('ArrowRight')
  await sleep(500)
  return await page.evaluate(() => document.activeElement.href)
}

// remove /u/0/
const clean = (link) => {
  return link.replace(/\/u\/\d+\//, '/')
}

program
  .name('google-photos-backup')
  .description('Backup your google photos library using playwright')

program
  .command("start")
  .option('--headless <value>', 'Run browser in headless mode', 'true')
  .option('--photo-directory <value>', 'Directory to download photos to', './download')
  .option('--session-directory <value>', 'Chrome session directory', './session')
  .option('--initial-photo-url <value>', 'URL of your oldest photo. This parameter is only used when the .lastdone file is not available')
  .option('--write-scraped-exif', 'When no data metadata is available, set scraped webpage date data as metadata', false)
  .option('--flat-directory-structure', 'Insteas of using a nested folder structure (year, month), download all photos to a single folder', false)
  .action(options => {
    start({
      headless: options.headless === "true",
      photoDirectory: options.photoDirectory,
      sessionDirectory: options.sessionDirectory,
      initialPhotoUrl: options.initialPhotoUrl,
      writeScrapedExif: options.writeScrapedExif,
      flatDirectoryStructure: options.flatDirectoryStructure
    })
  })

program
  .command('setup')
  .option('--session-directory <value>', 'Chrome session directory', './session')
  .action(options => {
    setup(options.sessionDirectory)
  })

program.parse()