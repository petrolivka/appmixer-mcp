import { EventSource } from 'eventsource';

function isTokenExpired(token) {
    try {
        // Just decode the payload part (no secret needed)
        const payload = JSON.parse(atob(token.split('.')[1]));
        const currentTime = Math.floor(Date.now() / 1000);
        return payload.exp < currentTime;
    } catch (error) {
        return true;
    }
}

export class AppmixerClient {
  constructor({ baseUrl, accessToken, username, password }) {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
    this.username = username
    this.password = password;
    if (!this.baseUrl) {
      throw new Error('Base URL is required for AppmixerClient');
    }
    if (!this.accessToken && (!this.username || !this.password)) {
      throw new Error('Either access token or username and password are required for AppmixerClient');
    }
  }

  async request(url, method = 'GET', body) {
      if (!this.accessToken || isTokenExpired(this.accessToken)) {
        this.accessToken = await this.refreshToken();
      }
      const req = {
        method,
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      };
      if (body) {
        req.body = JSON.stringify(body);
      }
      const response = await fetch(url, req);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (err) {
        return text;
      }
  }

  async refreshToken() {
    try {
      const response = await fetch(`${this.baseUrl}/user/auth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password
        })
      });
      if (!response.ok) {
        throw new Error(`Failed to refresh token: ${response.statusText}`);
      }
      const data = await response.json();
      return data.token;
    } catch (e) {
      console.error('Error refreshing token:', e);
    }
  }
  
  async getFlows(options = {}) {
    const params = new URLSearchParams;
    if (options.pattern) {
      params.append('pattern', options.pattern);
    }
    params.append('sort', 'mtime:-1');
    params.append('projection', '-thumbnail');
    try {
      return this.request(`${this.baseUrl}/flows?${params.toString()}`);
    } catch (e) {
      console.error(e);
    }
  }
  
  async getFlow(id) {
    try {
      return this.request(`${this.baseUrl}/flows/${id}`);
    } catch (e) {
      console.error(e);
    }
  }

  async deleteFlow(id) {
    try {
      return this.request(`${this.baseUrl}/flows/${id}`, 'DELETE');
    } catch (e) {
      console.error(e);
    }
  }

  async startFlow(id) {
    try {
      return this.request(`${this.baseUrl}/flows/${id}/coordinator`, 'POST', {
        command: 'start'
      });
    } catch (e) {
      console.error(e);
    }
  }

  async stopFlow(id) {
    try {
      return this.request(`${this.baseUrl}/flows/${id}/coordinator`, 'POST', {
        command: 'stop'
      });
    } catch (e) {
      console.error(e);
    }
  }

  async triggerComponent(flowId, componentId, method = 'POST', body = '') {
    try {
      const requestBody = body ? JSON.parse(body) : {};
      return this.request(`${this.baseUrl}/flows/${flowId}/components/${componentId}`, method, requestBody);
    } catch (e) {
      console.error(e);
    }
  }

  async sendAppEvent(event, data) {
    try {
      const body = data ? JSON.parse(data) : {};
      return this.request(`${this.baseUrl}/plugins/appmixer/utils/appevents/events/${event}`, 'POST', body);
    } catch (e) {
      console.error(e);
    }
  }

  async getLogs(flowId, query) {
    try {
      let queryString = 'flowId=' + flowId;
      if (query) {
        queryString += `&query=${encodeURIComponent(query)}`;
      }
      return this.request(`${this.baseUrl}/logs?${queryString}`);
    } catch (e) {
      console.error(e);
    }
  }

  async getGateways() {
    try {
      return this.request(`${this.baseUrl}/plugins/appmixer/ai/mcptools/gateways`);
    } catch (e) {
      console.error(e);
    }
  }

  async connectEventSource(onMessage) {
    if (!this.accessToken || isTokenExpired(this.accessToken)) {
        this.accessToken = await this.refreshToken();
    }
    const url = `${this.baseUrl}/plugins/appmixer/ai/mcptools/events?token=${this.accessToken}`;
    const eventSource = new EventSource(url);

    eventSource.addEventListener('error', (err) => {
      console.error('EventSource error:', err);
      eventSource.close();
      setTimeout(() => {
        this.connectEventSource(onMessage); // Reconnect on error
      }, 5000); // Retry after 5 seconds
    });

    eventSource.addEventListener('open', () => {
    });

    eventSource.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
        // Handle the event data as needed
      } catch (err) {
        console.error('Error parsing event data:', err);
      }
    });
  }
}
