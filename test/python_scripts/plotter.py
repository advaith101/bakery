import sys
import json
import matplotlib.pyplot as plt


# plots line graph of given x and y data
def plot(x, y):
    plt.plot(x, y)
    plt.xlabel('Time (blocks)')
    plt.ylabel('Supply (tokens)')
    plt.title('Token Supply vs. Time (over {} years)'.format(sys.argv[2]))
    #save plot to .png file
    plt.savefig('supply_over_time_{}yrs.png'.format(sys.argv[2]))


# main function
if __name__ == '__main__':
    # read data from command line
    data = json.loads(sys.argv[1])
    x = data['x']
    y = data['y']
    plot(x, y)