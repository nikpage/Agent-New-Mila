'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

interface DashboardStats {
  totalUsers: number
  activeUsers: number
  actionsLast24h: number
  recentErrors: Array<{
    id: string
    type: string
    message: string
    time: string
  }>
  users: Array<{
    id: string
    email: string
    enabled: boolean
    joined: string
    lastActive: string
    timezone: string
    mode: string
  }>
}

export default function SuperAdminDashboard() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [key, setKey] = useState<string>('')
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const urlKey = searchParams.get('key')
    const storedKey = localStorage.getItem('superadmin_key')
    const activeKey = urlKey || storedKey

    if (activeKey) {
      setKey(activeKey)
      if (urlKey) {
        localStorage.setItem('superadmin_key', urlKey)
        // Clean URL
        router.replace('/superadmin')
      }
      fetchStats(activeKey)
    } else {
      setLoading(false)
    }
  }, [searchParams, router])

  const fetchStats = async (apiKey: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/superadmin/stats?key=${apiKey}`)
      if (!res.ok) throw new Error('Unauthorized or Error')
      const data = await res.json()
      setStats(data)
      setError('')
    } catch (err) {
      setError('Failed to load stats. Check your key.')
      localStorage.removeItem('superadmin_key')
    } finally {
      setLoading(false)
    }
  }

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault()
    const inputKey = (e.target as any).key.value
    setKey(inputKey)
    localStorage.setItem('superadmin_key', inputKey)
    fetchStats(inputKey)
  }

  if (!key || error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <form onSubmit={handleLogin} className="bg-white p-8 rounded shadow-md w-96">
          <h1 className="text-xl font-bold mb-4">Superadmin Login</h1>
          {error && <p className="text-red-500 mb-4 text-sm">{error}</p>}
          <input
            name="key"
            type="password"
            placeholder="Enter Secret Key"
            className="w-full border p-2 rounded mb-4"
            autoFocus
          />
          <button type="submit" className="w-full bg-black text-white p-2 rounded">
            Access Dashboard
          </button>
        </form>
      </div>
    )
  }

  if (loading) return <div className="p-8">Loading stats...</div>

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Mila Superadmin</h1>
          <button
            onClick={() => fetchStats(key)}
            className="px-4 py-2 bg-white border rounded hover:bg-gray-50"
          >
            Refresh
          </button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white p-6 rounded-lg shadow-sm border">
            <h3 className="text-gray-500 text-sm font-medium">Total Users</h3>
            <p className="text-3xl font-bold mt-2">{stats?.totalUsers}</p>
            <p className="text-sm text-green-600 mt-1">{stats?.activeUsers} Active</p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-sm border">
            <h3 className="text-gray-500 text-sm font-medium">Actions (24h)</h3>
            <p className="text-3xl font-bold mt-2">{stats?.actionsLast24h}</p>
            <p className="text-sm text-gray-400 mt-1">AI Usage Proxy</p>
          </div>
          <div className="bg-white p-6 rounded-lg shadow-sm border">
            <h3 className="text-gray-500 text-sm font-medium">System Health</h3>
            <p className="text-3xl font-bold mt-2 text-green-600">
              {stats?.recentErrors.length === 0 ? 'Healthy' : 'Issues'}
            </p>
            <p className="text-sm text-red-500 mt-1">
              {stats?.recentErrors.length} Recent Errors
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* User List */}
          <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
            <div className="px-6 py-4 border-b bg-gray-50">
              <h2 className="font-semibold text-gray-700">Users</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-gray-500 bg-gray-50 border-b">
                  <tr>
                    <th className="px-6 py-3">Email</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Last Active</th>
                    <th className="px-6 py-3">Config</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stats?.users.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 font-medium">{user.email}</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-1 rounded-full text-xs ${
                          user.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {user.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-gray-500">
                        {user.lastActive ? new Date(user.lastActive).toLocaleDateString() : 'Never'}
                      </td>
                      <td className="px-6 py-4 text-gray-500 text-xs">
                        {user.timezone}<br/>{user.mode}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent Errors */}
          <div className="bg-white rounded-lg shadow-sm border overflow-hidden">
            <div className="px-6 py-4 border-b bg-gray-50">
              <h2 className="font-semibold text-gray-700">Recent Errors</h2>
            </div>
            <div className="divide-y max-h-[500px] overflow-y-auto">
              {stats?.recentErrors.map((err) => (
                <div key={err.id} className="p-4 hover:bg-gray-50">
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-mono text-xs font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded">
                      {err.type}
                    </span>
                    <span className="text-xs text-gray-400">
                      {new Date(err.time).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="text-sm text-gray-800 break-words font-mono">
                    {err.message}
                  </p>
                </div>
              ))}
              {stats?.recentErrors.length === 0 && (
                <div className="p-8 text-center text-gray-500">
                  No recent errors found.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
