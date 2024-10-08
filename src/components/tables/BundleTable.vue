<script setup lang="ts">
import IconTrash from '~icons/heroicons/trash?raw'
import { useI18n } from 'petite-vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type { Ref } from 'vue'
import { appIdToUrl, bytesToMbText } from '~/services/conversion'
import { formatDate } from '~/services/date'
import { useSupabase } from '~/services/supabase'
import { useDisplayStore } from '~/stores/display'
import type { OrganizationRole } from '~/stores/organization'
import type { Database } from '~/types/supabase.types'
import type { TableColumn } from '../comp_def'

const props = defineProps<{
  appId: string
}>()

type Element = Database['public']['Tables']['app_versions']['Row'] & Database['public']['Tables']['app_versions_meta']['Row']

const columns: Ref<TableColumn[]> = ref<TableColumn[]>([])
const role = ref<OrganizationRole | null>(null)
const offset = 10
const { t } = useI18n()
const displayStore = useDisplayStore()
const supabase = useSupabase()
const router = useRouter()
const organizationStore = useOrganizationStore()
const total = ref(0)
const search = ref('')
const elements = ref<Element[]>([])
const isLoading = ref(false)
const currentPage = ref(1)
const filters = ref({
  'external-storage': false,
  'deleted': false,
  'encrypted': false,
})
const currentVersionsNumber = computed(() => {
  return (currentPage.value - 1) * offset
})
async function didCancel(name: string): Promise<boolean | 'normal' | 'unsafe'> {
  let method: 'normal' | 'unsafe' | null = null
  displayStore.dialogOption = {
    header: t('select-style-of-deletion'),
    message: t('select-style-of-deletion-msg').replace('$1', `<a href="https://capgo.app/docs/webapp/bundles/#delete-a-bundle">${t('here')}</a>`),
    buttons: [
      {
        text: t('normal'),
        role: 'normal',
        handler: () => {
          method = 'normal'
        },
      },
      {
        text: t('unsafe'),
        role: 'danger',
        id: 'unsafe',
        handler: async () => {
          if (!organizationStore.hasPermisisonsInRole(await organizationStore.getCurrentRoleForApp(props.appId), ['super_admin'])) {
            toast.error(t('no-permission-ask-super-admin'))
            return
          }
          method = 'unsafe'
        },
      },
    ],
  }
  displayStore.showDialog = true
  if (await displayStore.onDialogDismiss() || !method) {
    return true
  }
  displayStore.dialogOption = {
    header: t('alert-confirm-delete'),
    message: `${t('alert-not-reverse-message')} ${t('alert-delete-message')} ${name} ${t('you-cannot-reuse')}.`,
    buttons: [
      {
        text: t('button-cancel'),
        role: 'cancel',
      },
      {
        text: t('button-delete'),
        role: 'danger',
        id: 'confirm-button',
      },
    ],
  }
  displayStore.showDialog = true
  if (await displayStore.onDialogDismiss())
    return true
  if (method === null)
    throw new Error('Unreachable, method = null')
  return method
}
async function enhenceVersionElems(dataVersions: Database['public']['Tables']['app_versions']['Row'][]) {
  const { data: dataVersionsMeta } = await supabase
    .from('app_versions_meta')
    .select()
    .in('id', dataVersions.map(({ id }) => id))
  const newVersions = dataVersions.map(({ id, ...rest }) => {
    const version = dataVersionsMeta ? dataVersionsMeta.find(({ id: idMeta }) => idMeta === id) : { size: 0, checksum: '' }
    return { id, ...rest, ...version } as Element
  })
  return newVersions
}
async function getData() {
  isLoading.value = true
  try {
    let req = supabase
      .from('app_versions')
      .select('*', { count: 'exact' })
      .eq('app_id', props.appId)
      .range(currentVersionsNumber.value, currentVersionsNumber.value + offset - 1)

    if (search.value)
      req = req.like('name', `%${search.value}%`)

    req = req.eq('deleted', filters.value.deleted)
    if (filters.value['external-storage'])
      req = req.neq('external_url', null)
    if (filters.value.encrypted)
      req = req.neq('session_key', null)
    if (columns.value.length) {
      columns.value.forEach((col) => {
        if (col.sortable && typeof col.sortable === 'string')
          req = req.order(col.key as any, { ascending: col.sortable === 'asc' })
      })
    }
    const { data: dataVersions, count } = await req
    if (!dataVersions)
      return
    elements.value.push(...(await enhenceVersionElems(dataVersions)))
    // console.log('count', count)
    total.value = count || 0
  }
  catch (error) {
    console.error(error)
  }
  isLoading.value = false
}
async function refreshData() {
  // console.log('refreshData')
  try {
    currentPage.value = 1
    elements.value.length = 0
    await getData()
  }
  catch (error) {
    console.error(error)
  }
}
async function deleteOne(one: Element) {
  // console.log('deleteBundle', bundle)

  if (role.value && !organizationStore.hasPermisisonsInRole(role.value, ['admin', 'write', 'super_admin'])) {
    toast.error(t('no-permission'))
    return
  }

  try {
    // todo: fix this for AB testing
    const { data: channelFound, error: errorChannel } = await supabase
      .from('channels')
      .select()
      .eq('app_id', one.app_id)
      .eq('version', one.id)

    let unlink = [] as Database['public']['Tables']['channels']['Row'][]
    if ((channelFound && channelFound.length) || errorChannel) {
      displayStore.dialogOption = {
        header: t('want-to-unlink'),
        message: t('channel-bundle-linked').replace('%', channelFound?.map(ch => ch.name).join(', ') ?? ''),
        buttons: [
          {
            text: t('yes'),
            role: 'yes',
            id: 'yes',
            handler: () => {
              if (channelFound)
                unlink = channelFound
            },
          },
          {
            text: t('no'),
            id: 'cancel',
            role: 'cancel',
          },
        ],
      }
      displayStore.showDialog = true
      if (await displayStore.onDialogDismiss()) {
        toast.error(t('canceled-delete'))
        return
      }
    }

    if (one.deleted)
      return
    const didCancelRes = await didCancel(t('version'))
    if (typeof didCancelRes === 'boolean' && didCancelRes === true)
      return

    if (unlink.length > 0) {
      const { data: unknownVersion, error: unknownError } = await supabase
        .from('app_versions')
        .select()
        .eq('app_id', one.app_id)
        .eq('name', 'unknown')
        .single()

      if (unknownError) {
        toast.error(t('cannot-find-unknown-version'))
        console.error('Cannot find unknown', JSON.stringify(unknownError))
        return
      }

      const { error: updateError } = await supabase
        .from('channels')
        .update({ version: unknownVersion.id })
        .in('id', unlink.map(c => c.id))

      if (updateError) {
        toast.error(t('unlink-error'))
        console.error('unlink error (updateError)', updateError)
        return
      }
    }

    const { data: deviceFound, error: errorDevice } = await supabase
      .from('devices_override')
      .select()
      .eq('app_id', one.app_id)
      .eq('version', one.id)
    if ((deviceFound && deviceFound.length) || errorDevice) {
      toast.error(`${t('version')} ${one.app_id}@${one.name} ${t('bundle-is-linked-device')}`)
      return
    }
    const { error: delAppError } = await (didCancelRes === 'normal'
      ? supabase
        .from('app_versions')
        .update({ deleted: true })
        .eq('app_id', one.app_id)
        .eq('id', one.id)
      : supabase
        .from('app_versions')
        .delete()
        .eq('app_id', one.app_id)
        .eq('id', one.id)
    )

    if (delAppError) {
      toast.error(t('cannot-delete-bundle'))
    }
    else {
      toast.success(t('bundle-deleted'))
      await refreshData()
    }
  }
  catch (error) {
    console.error(error)
    toast.error(t('cannot-delete-bundle'))
  }
}

columns.value = [
  {
    label: t('name'),
    key: 'name',
    mobile: true,
    sortable: true,
    head: true,
  },
  {
    label: t('created-at'),
    key: 'created_at',
    mobile: true,
    sortable: 'desc',
    displayFunction: (elem: Element) => formatDate(elem.created_at || ''),
  },
  {
    label: t('size'),
    mobile: false,
    key: 'size',
    sortable: true,
    displayFunction: (elem: Element) => {
      if (elem.size)
        return bytesToMbText(elem.size)
      else if (elem.external_url)
        return t('stored-externally')
      else if (elem.deleted)
        return t('deleted')
      else
        return t('size-not-found')
    },
  },
  {
    label: t('action'),
    key: 'action',
    mobile: true,
    icon: IconTrash,
    class: 'text-red-500',
    onClick: deleteOne,
  },
]

async function reload() {
  console.log('reload')
  try {
    elements.value.length = 0
    await getData()
  }
  catch (error) {
    console.error(error)
  }
}

async function openOne(one: Element) {
  if (one.deleted)
    return
  router.push(`/app/p/${appIdToUrl(props.appId)}/bundle/${one.id}`)
}
onMounted(async () => {
  await refreshData()
  role.value = await organizationStore.getCurrentRoleForApp(props.appId)
})
watch(props, async () => {
  await refreshData()
  role.value = await organizationStore.getCurrentRoleForApp(props.appId)
})
</script>

<template>
  <Table
    v-model:filters="filters" v-model:columns="columns" v-model:current-page="currentPage" v-model:search="search"
    :total="total" row-click :element-list="elements"
    filter-text="filters"
    :is-loading="isLoading"
    :search-placeholder="t('search-bundle-id')"
    @reload="reload()" @reset="refreshData()"
    @row-click="openOne"
  />
</template>
