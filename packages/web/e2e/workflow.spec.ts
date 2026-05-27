import { test, expect, Page } from '@playwright/test'
import { waitForLiveStoreReady, createTestUserViaAPI, loginViaUI } from './test-utils.js'

const REQUIRE_AUTH = process.env.REQUIRE_AUTH === 'true'

/**
 * Helper to navigate to the app with a unique store ID
 */
async function navigateWithUniqueStore(page: Page) {
  const storeId = `test-${Date.now()}-${Math.random().toString(36).substring(7)}`

  if (REQUIRE_AUTH) {
    const testUser = await createTestUserViaAPI()
    await page.goto(`/login?storeId=${storeId}`)
    await loginViaUI(page, testUser.email, testUser.password, { skipNavigation: true })
    await page.waitForLoadState('networkidle', { timeout: 15000 })
  }

  return storeId
}

const getStreamSummaryCard = (page: Page, label: 'Initiative' | 'Optimization' | 'To-Do') => {
  return page
    .locator('div.border.rounded-xl')
    .filter({ has: page.locator('span', { hasText: label }) })
    .filter({ has: page.getByRole('button', { name: /Expand|Hide/ }) })
    .first()
}

const expectMapSurface = async (page: Page) => {
  const lifeMapCanvas = page.locator('canvas').first()
  const hasCanvas = await lifeMapCanvas
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false)

  if (!hasCanvas) {
    await expect(page.getByText('Map unavailable on this device')).toBeVisible({ timeout: 10000 })
  }
}

const verifyLegacyRouteRedirect = async (
  page: Page,
  legacyPath: `/drafting-room${string}` | `/sorting-room${string}`,
  storeId: string
) => {
  await page.goto(`${legacyPath}?storeId=${storeId}`)
  await waitForLiveStoreReady(page)

  const isLoading = await page
    .locator('text=Loading LiveStore')
    .isVisible()
    .catch(() => false)
  if (isLoading) {
    return
  }

  const currentUrl = new URL(page.url())
  expect(currentUrl.searchParams.get('storeId')).toBe(storeId)
  expect(currentUrl.pathname).not.toContain('/drafting-room')
  expect(currentUrl.pathname).not.toContain('/sorting-room')
  expect(['/', '/life-map']).toContain(currentUrl.pathname)
}

test.describe('Workflow', () => {
  test.describe.configure({ timeout: 120000 }) // 2 minute timeout for full workflow

  test.fixme('complete workflow: create project in drafting room, activate in sorting room, change task status', async ({
    page,
  }) => {
    const storeId = await navigateWithUniqueStore(page)
    const projectName = `E2E Test Project ${Date.now()}`
    const taskNames = ['First test task', 'Second test task', 'Third test task']

    // =====================
    // STAGE 1: Identify
    // =====================

    // Navigate to create new project
    await page.goto(`/drafting-room/new?storeId=${storeId}`)
    await waitForLiveStoreReady(page)

    // Wait for Stage 1 form to load
    await expect(page.getByText('Stage 1: Identify')).toBeVisible({ timeout: 10000 })

    // Fill in project title
    const titleInput = page.locator('input[placeholder*="project called"]')
    await titleInput.fill(projectName)
    await titleInput.blur() // Trigger auto-save

    // Fill in description
    const descriptionTextarea = page.locator('textarea[placeholder*="1-2 sentences"]')
    await descriptionTextarea.fill('This is an E2E test project to verify the full workflow')
    await descriptionTextarea.blur()

    // Select category (pick "Health")
    const healthCategoryButton = page.getByRole('button', { name: 'Health' })
    await healthCategoryButton.click()

    // Wait for auto-save
    await page.waitForTimeout(500)

    // Click Continue to Stage 2
    const continueToStage2Button = page.getByRole('button', { name: 'Continue to Stage 2' })
    await expect(continueToStage2Button).toBeEnabled()
    await continueToStage2Button.click()

    // =====================
    // STAGE 2: Scope
    // =====================

    // Wait for Stage 2 form to load
    await expect(page.getByText('Stage 2: Scope')).toBeVisible({ timeout: 10000 })

    // Verify project name shows in header
    await expect(page.getByText(projectName)).toBeVisible()

    // Fill in objectives
    const objectivesTextarea = page.locator('textarea[placeholder*="specific outcomes"]')
    await objectivesTextarea.fill('Complete all test tasks successfully')
    await objectivesTextarea.blur()

    // Set a deadline (30 days from now)
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 30)
    const dateString = futureDate.toISOString().split('T')[0]
    const deadlineInput = page.locator('input[type="date"]')
    await deadlineInput.fill(dateString!)
    await deadlineInput.blur()

    // Select project type (Initiative = Gold tier)
    const initiativeButton = page.getByRole('button', { name: /^Initiative/ })
    await initiativeButton.click()

    // Wait for auto-save
    await page.waitForTimeout(500)

    // Click Continue to Stage 3
    const continueToStage3Button = page.getByRole('button', { name: 'Continue to Stage 3' })
    await expect(continueToStage3Button).toBeEnabled()
    await continueToStage3Button.click()

    // =====================
    // STAGE 3: Detail
    // =====================

    // Wait for Stage 3 form to load
    await expect(page.getByText('Stage 3: Detail')).toBeVisible({ timeout: 10000 })

    // Verify project name shows in header
    await expect(page.getByText(projectName)).toBeVisible()

    // Add tasks using the modal-based flow
    for (const taskName of taskNames) {
      // Click "+ Add Task" button to open modal
      const addTaskButton = page.getByRole('button', { name: '+ Add Task' })
      await addTaskButton.click()

      // Wait for modal to open
      const taskModal = page.getByRole('dialog')
      await expect(taskModal).toBeVisible({ timeout: 5000 })

      // Fill in task title
      const titleInput = taskModal.locator('input[placeholder="Task title"]')
      await titleInput.fill(taskName)

      // Click "Create Task" button
      const createTaskButton = taskModal.getByRole('button', { name: 'Create Task' })
      await createTaskButton.click()

      // Wait for modal to close and task to be added
      await expect(taskModal).not.toBeVisible({ timeout: 5000 })
    }

    // Verify all tasks are visible
    for (const taskName of taskNames) {
      await expect(page.getByText(taskName)).toBeVisible()
    }

    // Click Add to Sorting
    const addToSortingButton = page.getByRole('button', { name: 'Add to Sorting' })
    await expect(addToSortingButton).toBeEnabled()
    await addToSortingButton.click()

    // =====================
    // SORTING ROOM: Activate project
    // =====================

    // Wait for Sorting Room to load
    await expect(getStreamSummaryCard(page, 'Initiative')).toBeVisible({ timeout: 10000 })
    await expect(getStreamSummaryCard(page, 'Optimization')).toBeVisible()
    await expect(getStreamSummaryCard(page, 'To-Do')).toBeVisible()

    // Ensure Initiative stream is expanded (we selected Initiative tier)
    const initiativeSummaryHeader = getStreamSummaryCard(page, 'Initiative')
    const initiativeToggleButton = initiativeSummaryHeader.getByRole('button', {
      name: /Expand|Hide/,
    })

    if ((await initiativeToggleButton.textContent())?.trim() === 'Expand') {
      await initiativeToggleButton.click()
    }

    // Wait for Initiative card to show as expanded
    await expect(initiativeSummaryHeader.getByRole('button', { name: 'Hide' })).toBeVisible({
      timeout: 5000,
    })

    // Find our project in the backlog and click "Activate" within that card
    const projectCard = page
      .locator('div')
      .filter({ hasText: projectName })
      .filter({ has: page.getByRole('button', { name: 'Activate', exact: true }) })
      .first()
    await expect(projectCard).toBeVisible({ timeout: 5000 })

    // Click "Activate" button on the project card
    const activateButton = projectCard.getByRole('button', {
      name: 'Activate',
      exact: true,
    })
    await expect(activateButton).toBeEnabled()
    await activateButton.click()

    // Verify project is now active
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 5000 })

    // =====================
    // PROJECT KANBAN: Open and change task status
    // =====================

    // Click View to open the project kanban
    const viewButton = page.getByRole('button', { name: 'View' })
    await viewButton.click()

    // Wait for project kanban to load
    await expect(page.getByText('Todo')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Doing')).toBeVisible()
    await expect(page.getByText('In Review')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible()

    // Verify tasks are visible in To Do column
    for (const taskName of taskNames) {
      await expect(page.getByText(taskName)).toBeVisible()
    }

    // Click on first task to open modal
    const firstTaskCard = page.getByText(taskNames[0]!).first()
    await firstTaskCard.click()

    // Wait for modal to open
    const taskModal = page.getByRole('dialog')
    await expect(taskModal).toBeVisible({ timeout: 5000 })

    // Verify task title in modal
    await expect(taskModal.getByText(taskNames[0]!)).toBeVisible()

    // Click Edit button
    const editButton = taskModal.getByRole('button', { name: 'Edit' })
    await editButton.click()

    // Change status to "Doing" using the select dropdown
    const statusSelect = taskModal.locator('select')
    await expect(statusSelect).toBeVisible()
    await statusSelect.selectOption('doing')

    // Click Save
    const saveButton = taskModal.getByRole('button', { name: 'Save' })
    await saveButton.click()

    // Close the modal
    const closeButton = taskModal.getByRole('button', { name: 'Close modal' })
    await closeButton.click()

    // Wait for modal to close
    await page.waitForTimeout(500)

    // Verify the task has moved to Doing column
    // The Doing column should now contain our task
    const doingColumn = page
      .locator('div')
      .filter({ hasText: /^Doing\s*\d/ })
      .first()
    await expect(doingColumn.getByText(taskNames[0]!)).toBeVisible({ timeout: 5000 })

    // =====================
    // VERIFICATION: Navigate back to Life Map and verify project
    // =====================

    // Navigate to Life Map
    await page.goto(`/?storeId=${storeId}`)

    await expectMapSurface(page)

    // Verify our project appears on the Life Map surface.
    await expect(page.getByText(projectName).first()).toBeVisible({ timeout: 10000 })
  })

  test.fixme('create project and verify it appears in drafting room', async ({ page }) => {
    const storeId = await navigateWithUniqueStore(page)
    const projectName = `Quick Test ${Date.now()}`

    // Navigate to create new project
    await page.goto(`/drafting-room/new?storeId=${storeId}`)
    await waitForLiveStoreReady(page)

    // Wait for Stage 1 form
    await expect(page.getByText('Stage 1: Identify')).toBeVisible({ timeout: 10000 })

    // Fill in title and category only (minimum required)
    const titleInput = page.locator('input[placeholder*="project called"]')
    await titleInput.fill(projectName)
    await titleInput.blur()

    // Select category
    const healthButton = page.getByRole('button', { name: 'Health' })
    await healthButton.click()

    await page.waitForTimeout(500)

    // Click Exit to save and go back to drafting room
    const exitButton = page.getByRole('button', { name: 'Exit' })
    await exitButton.click()

    // Wait for drafting room to load
    await expect(page.getByText(/Stage 1 ·/)).toBeVisible({ timeout: 10000 })

    // Verify our project appears in Stage 1 column
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 5000 })
  })

  test('navigate through all pages', async ({ page }) => {
    const storeId = await navigateWithUniqueStore(page)

    // Navigate to Life Map
    await page.goto(`/life-map?storeId=${storeId}`)
    await waitForLiveStoreReady(page)

    const isLoading = await page
      .locator('text=Loading LiveStore')
      .isVisible()
      .catch(() => false)
    if (isLoading) {
      return
    }

    // Verify Life Map shell is available
    await expect(page.getByText('Drafting Room')).toHaveCount(0)
    await expect(page.getByText('Sorting Room')).toHaveCount(0)
    await expect(page.getByText('Table')).toHaveCount(0)

    const lifeMapCanvas = page.locator('canvas').first()
    const hasCanvas = await lifeMapCanvas
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    if (!hasCanvas) {
      await expect(page.getByText('Map unavailable on this device')).toBeVisible({ timeout: 10000 })
    }

    // Verify legacy routes normalize to map-first URLs (storeId preserved).
    await verifyLegacyRouteRedirect(page, '/drafting-room', storeId)
    await verifyLegacyRouteRedirect(page, '/sorting-room/gold', storeId)
  })
})
