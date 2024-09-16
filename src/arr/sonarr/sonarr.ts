import axios from 'axios';
import { config } from '../../config';
import logger from '../../logger';

export async function sonarrStatus(): Promise<boolean> {
    try {
        const response = await axios.get(`${config.sonarr.url}/api/v3/system/status`, {
            headers: {
                'X-Api-Key': config.sonarr.apiKey
            }
        });

        if (response.status === 200) {
            logger.info('Sonarr API test successful');
            return true;
        } else {
            logger.error(`Sonarr API test failed with status: ${response.status}`);
            return false;
        }
    } catch (error) {
        logger.error('Error testing Sonarr API:', error);
        return false;
    }
}

export async function getAllShows(): Promise<any[]> {
    try {
        const response = await axios.get(`${config.sonarr.url}/api/v3/series`, {
            headers: {
                'X-Api-Key': config.sonarr.apiKey
            }
        });

        if (response.status === 200) {
            logger.info('Successfully fetched all shows from Sonarr');
            return response.data;
        } else {
            logger.error(`Failed to fetch shows from Sonarr. Status: ${response.status}`);
            return [];
        }
    } catch (error) {
        logger.error('Error fetching shows from Sonarr:', error);
        return [];
    }
}
